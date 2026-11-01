import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "../src/server/config.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
const ownerFile =
  process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json";
const { owner } = JSON.parse(await readFile(ownerFile, "utf8"));
const stamp = Date.now().toString(36);
const fixture = {
  project: `自举验收项目 ${stamp}`,
  environment: `自举开发环境 ${stamp}`,
  knowledge: `自举知识条目 ${stamp}`,
};
const targetUser = {
  name: "自举测试账号",
  email: `selftest-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};

class Client {
  private cookie = "";
  constructor(private readonly base: string) {}
  async request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0]!;
    const data: any = await response.json();
    assert.equal(
      response.status,
      200,
      `${method} ${path}: ${data.error || response.status}`,
    );
    return data;
  }
}

async function waitRun(id: string) {
  const start = Date.now();
  let previous = "";
  while (Date.now() - start < config.runTimeoutMs + 30_000) {
    const result = await controller.request(`/runs/${id}`);
    const latest = result.events.at(-1);
    const label = `${result.run.status}: ${latest?.kind || "queued"}`;
    if (label !== previous) {
      console.log(label);
      previous = label;
    }
    if (result.run.events_complete) return result;
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Self-test run timed out");
}

const controller = new Client(controllerUrl);
await controller.request("/auth/login", "POST", owner);
if (process.argv.includes("--replay")) {
  const previous = JSON.parse(
    await readFile(".data/self-test-result.json", "utf8"),
  );
  const run = await controller.request(
    `/runs/${previous.repairedRunId || previous.generatedRunId}`,
  );
  const path = `/projects/${previous.projectId}?environmentId=${previous.environmentId}`;
  const before = await controller.request(path);
  const replay = await controller.request(
    `/projects/${previous.projectId}/runs`,
    "POST",
    {
      environmentId: previous.environmentId,
      caseId: run.run.case_id,
      flowId: previous.flowId,
      mode: "execute",
    },
  );
  const result = await waitRun(replay.id);
  assert.equal(result.run.status, "passed", result.run.error);
  const after = await controller.request(path);
  assert.deepEqual(
    after.nodes.map((n: any) => n.revision_id).sort(),
    before.nodes.map((n: any) => n.revision_id).sort(),
  );
  await writeFile(
    ".data/self-test-result.json",
    JSON.stringify({ ...previous, replayRunId: replay.id }, null, 2),
  );
  console.log("PASS self-test replay reused the same node revisions");
} else {
  const target = new Client(targetUrl);
  const targetHealth = await target.request("/health");
  assert.equal(targetHealth.database, true);
  await target.request("/auth/register", "POST", targetUser);
  const fixtureProject = await target.request("/projects", "POST", {
    name: fixture.project,
    description: "独立数据库中的自举测试数据",
  });
  await target.request(`/projects/${fixtureProject.id}/environments`, "POST", {
    name: fixture.environment,
    baseUrl: targetUrl,
    variables: {},
  });
  await target.request(`/projects/${fixtureProject.id}/knowledge`, "POST", {
    title: fixture.knowledge,
    content: "LoopLab 自举测试使用的固定知识条目。",
  });
  const project = await controller.request("/projects", "POST", {
    name: `LoopLab 自举测试 ${stamp}`,
    description: "通过 Agent 在真实浏览器中测试独立的 LoopLab 实例",
  });
  const environment = await controller.request(
    `/projects/${project.id}/environments`,
    "POST",
    {
      name: "隔离的被测 LoopLab",
      baseUrl: targetUrl,
      variables: {},
      secrets: { username: targetUser.email, password: targetUser.password },
    },
  );
  await controller.request(`/projects/${project.id}/knowledge`, "POST", {
    title: "LoopLab 自举背景",
    content: `被测站点是 LoopLab 自身，登录页面输入邮箱和密码，分别使用 {{secret.username}} 和 {{secret.password}}，不要在节点中写入实际凭据。登录后是项目管理页；本账号只有一个预置项目，名称为“${fixture.project}”。进入项目后，环境管理页有“${fixture.environment}”环境；知识库有“${fixture.knowledge}”条目，侧边栏有 Agent 对话入口。页面存在多个指向 /projects 的链接，登录成功后可使用“项目管理”文本定位；Agent 对话页有嵌套的 main 元素，可用页面标题 h2 进行断言。请调查页面并确保每个选择器只匹配一个目标。测试只浏览已有数据，不要创建、修改或删除项目、环境、知识、用户或启动嵌套 Agent 任务。流程需能在全新浏览器中重复执行。`,
  });
  const chat = await controller.request(
    `/projects/${project.id}/chat/sessions`,
    "POST",
    {
      environmentId: environment.id,
      title: "LoopLab 登录和工作区自举测试",
    },
  );
  const sent = await controller.request(
    `/chat/sessions/${chat.id}/messages`,
    "POST",
    {
      text: `请测试 LoopLab 自身的最小可用性：真实浏览器登录后，分别断言项目管理页包含“${fixture.project}”、进入该项目后环境管理页面包含“${fixture.environment}”、知识库包含“${fixture.knowledge}”，进入 Agent 对话页面并断言标题“Agent 对话”。请调查真实页面，将登录、检查项目、检查环境、检查知识库、检查 Agent 对话和截图明确拆成至少 5 个独立的可复用节点；各节点只负责单一功能，不要把多个页面的检查合并在一个节点中。保存流程后由平台独立重放。只浏览现有数据，不创建或修改任何数据，也不要触发新的 Agent 运行。`,
      clientId: randomUUID(),
    },
  );
  console.log(`Self-test started: project ${project.id}, run ${sent.runId}`);

  const generated = await waitRun(sent.runId);
  assert.equal(generated.run.status, "passed", generated.run.error);
  assert.ok(generated.run.flow_id, "Agent did not save a flow");
  const passedAssertions = generated.events.filter(
    (event: any) =>
      event.kind === "step" &&
      event.data.status === "passed" &&
      event.data.step.action.startsWith("assert"),
  );
  for (const required of [
    fixture.project,
    fixture.environment,
    fixture.knowledge,
    "Agent 对话",
  ]) {
    assert.ok(
      passedAssertions.some((event: any) =>
        JSON.stringify(event.data.step).includes(required),
      ),
      `Missing browser assertion: ${required}`,
    );
  }
  assert.ok(generated.artifacts.length, "No screenshot recorded");
  const assets = await controller.request(
    `/projects/${project.id}?environmentId=${environment.id}`,
  );
  assert.ok(assets.nodes.length >= 5, "Expected reusable nodes");
  const replay = await controller.request(
    `/projects/${project.id}/runs`,
    "POST",
    {
      environmentId: environment.id,
      caseId: generated.run.case_id,
      flowId: generated.run.flow_id,
      mode: "execute",
    },
  );
  const repeated = await waitRun(replay.id);
  assert.equal(repeated.run.status, "passed", repeated.run.error);
  const after = await controller.request(
    `/projects/${project.id}?environmentId=${environment.id}`,
  );
  assert.deepEqual(
    after.nodes.map((node: any) => node.revision_id).sort(),
    assets.nodes.map((node: any) => node.revision_id).sort(),
  );
  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/self-test-result.json",
    JSON.stringify(
      {
        controllerUrl,
        targetUrl,
        projectId: project.id,
        environmentId: environment.id,
        chatId: chat.id,
        flowId: generated.run.flow_id,
        generatedRunId: sent.runId,
        replayRunId: replay.id,
        fixture,
        nodeCount: assets.nodes.length,
        assertionCount: passedAssertions.length,
        artifactCount: generated.artifacts.length,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS self-generated flow: ${assets.nodes.length} reusable nodes, ${passedAssertions.length} passed assertions, ${generated.artifacts.length} artifacts`,
  );
  console.log("PASS second browser replay reused the same node revisions");
}
