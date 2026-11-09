import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { config } from "../src/server/config.js";
import type { Step } from "../src/testing/spec.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
const fixtureUrl =
  process.env.SELF_TEST_JIRA_FIXTURE_URL || "http://127.0.0.1:4314";
const issueUrl = `${fixtureUrl}/browse/DEMO-1`;
assert.notEqual(new URL(controllerUrl).origin, new URL(targetUrl).origin);
const { owner } = JSON.parse(
  await readFile(
    process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json",
    "utf8",
  ),
);
const stamp = Date.now().toString(36);
await mkdir(".data", { recursive: true });
const record: Record<string, unknown> = { targetUrl, issueUrl };
const checkpoint = () =>
  writeFile(
    ".data/self-test-jira-result.json",
    JSON.stringify(record, null, 2),
  );
let loginCount = 0;
let uncheckedResume = false;

class Client {
  private cookie = "";
  constructor(readonly base: string) {}
  async raw(path: string, method = "GET", body?: unknown) {
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
    return response;
  }
  async request(path: string, method = "GET", body?: unknown) {
    const response = await this.raw(path, method, body);
    const data: any = await response.json();
    assert.equal(
      response.status,
      200,
      `${method} ${path}: ${data.error || response.status}`,
    );
    return data;
  }
  async waitRun(id: string, expected: string, handleLogin = false) {
    const deadline = Date.now() + config.runTimeoutMs + 120_000;
    while (Date.now() < deadline) {
      const result = await this.request(`/runs/${id}`);
      if (result.run.events_complete) {
        assert.equal(
          result.run.status,
          expected,
          result.run.error || result.run.summary,
        );
        return result;
      }
      if (handleLogin) {
        const intervention = await this.request(`/runs/${id}/intervention`);
        if (intervention.active) {
          assert.match(intervention.info.message, /Jira.*登录/);
          if (!uncheckedResume) {
            uncheckedResume = true;
            await this.request(`/runs/${id}/intervention/actions`, "POST", {
              type: "resume",
            });
            await setTimeout(700);
            continue;
          }
          const screenshot = await this.raw(
            `/runs/${id}/intervention/screenshot`,
          );
          assert.equal(screenshot.status, 200);
          await writeFile(
            `.data/jira-login-${++loginCount}.png`,
            Buffer.from(await screenshot.arrayBuffer()),
          );
          for (const action of [
            { type: "type", text: "jira-e2e@example.test" },
            { type: "press", key: "Tab" },
            { type: "type", text: "local-fixture-password" },
            { type: "press", key: "Enter" },
            { type: "resume" },
          ])
            await this.request(
              `/runs/${id}/intervention/actions`,
              "POST",
              action,
            );
        }
      }
      await setTimeout(900);
    }
    throw new Error(`运行超时：${id}`);
  }
}

const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
await fetch(`${fixtureUrl}/control?reset&sso=true`);
assert.equal((await target.request("/health")).database, true);
const user = {
  name: "Jira 自举账号",
  email: `jira-${stamp}@example.test`,
  password: randomBytes(24).toString("hex"),
};
await target.request("/auth/register", "POST", user);
await mkdir(".data/jira-fixture", { recursive: true });
await writeFile(
  ".data/jira-fixture/target-credentials.json",
  JSON.stringify({ email: user.email, password: user.password }),
  { mode: 0o600 },
);
const project = await target.request("/projects", "POST", {
  name: `Jira 分阶段自举 ${stamp}`,
});
const scope = `/projects/${project.id}`;
const environment = await target.request(`${scope}/environments`, "POST", {
  name: "Jira Echo 目标",
  baseUrl: `${fixtureUrl}/app`,
});
Object.assign(record, { projectId: project.id, environmentId: environment.id });
await checkpoint();
const uiProject = await controller.request("/projects", "POST", {
  name: `Jira 管理自举工作台 ${stamp}`,
});
const uiScope = `/projects/${uiProject.id}`;
const uiEnvironment = await controller.request(
  `${uiScope}/environments`,
  "POST",
  {
    name: "独立 LoopLab",
    baseUrl: targetUrl,
    secrets: { username: user.email, password: user.password },
  },
);
const loginNode = await controller.request(`${uiScope}/nodes`, "POST", {
  environmentId: uiEnvironment.id,
  key: "jira_ui_login",
  name: "登录独立 LoopLab",
  spec: {
    inputs: [],
    steps: [
      {
        action: "fill",
        selector: 'input[autocomplete="username"]',
        value: "{{secret.username}}",
      },
      {
        action: "fill",
        selector: 'input[autocomplete="current-password"]',
        value: "{{secret.password}}",
      },
      { action: "click", selector: 'button:has-text("登录")' },
      { action: "waitFor", selector: 'h2:has-text("项目管理")' },
    ],
  },
});
async function ui(title: string, key: string, steps: Step[]) {
  const testCase = await controller.request(`${uiScope}/cases`, "POST", {
    title,
    instructions: title,
  });
  const node = await controller.request(`${uiScope}/nodes`, "POST", {
    environmentId: uiEnvironment.id,
    key,
    name: title,
    spec: { inputs: [], steps },
  });
  const flow = await controller.request(`${uiScope}/flows`, "POST", {
    environmentId: uiEnvironment.id,
    caseId: testCase.id,
    name: title,
    steps: [
      { revisionId: loginNode.revisionId, params: {} },
      { revisionId: node.revisionId, params: {} },
    ],
  });
  const run = await controller.request(`${uiScope}/runs`, "POST", {
    environmentId: uiEnvironment.id,
    caseId: testCase.id,
    flowId: flow.id,
    mode: "execute",
  });
  console.log(`UI ${key}: ${run.id}`);
  await controller.waitRun(run.id, "passed");
  record[key] = run.id;
  await checkpoint();
}
async function ask(title: string, text: string, caseId?: string) {
  const session = await target.request(`${scope}/chat/sessions`, "POST", {
    title,
    environmentId: environment.id,
    ...(caseId ? { caseId } : {}),
  });
  const { runId } = await target.request(
    `/chat/sessions/${session.id}/messages`,
    "POST",
    { text, clientId: randomUUID() },
  );
  console.log(`Agent ${title}: ${runId}`);
  record[title] = runId;
  await checkpoint();
  return target.waitRun(runId, "completed", true);
}
const toolSucceeded = (result: any, name: string) =>
  result.events.some(
    (event: any) =>
      event.kind === "agent_tool_end" &&
      event.data.name === name &&
      !event.data.isError,
  );
const noExecution = (result: any) =>
  assert.ok(
    !result.events.some(
      (event: any) =>
        event.kind === "agent_tool_start" &&
        ["finish_flow", "run_flow"].includes(event.data.name),
    ),
    "当前阶段不应执行测试流程",
  );
const jiraPath = `${scope}/jira?env=${environment.id}`;
await ui("从 Jira 页面进入对话并请求读取", "jira_ui_read", [
  { action: "navigate", url: jiraPath },
  {
    action: "fill",
    selector: 'input[aria-label="Jira Ticket 链接"]',
    value: issueUrl,
  },
  { action: "click", selector: 'button:has-text("与 Agent 读取")' },
  {
    action: "waitFor",
    selector: 'textarea[placeholder="描述测试目标，或继续讨论与修改…"]',
  },
  { action: "click", selector: 'button[aria-label="发送消息"]' },
  {
    action: "waitFor",
    selector: 'a:has-text("前往人工接管")',
    timeoutMs: 150000,
  },
  { action: "click", selector: 'a:has-text("前往人工接管")' },
  { action: "waitFor", selector: '[aria-label="人工接管"]', timeoutMs: 150000 },
  { action: "screenshot", name: "jira-login-takeover.png" },
  { action: "assertText", selector: '[aria-label="人工接管"]', text: "Jira" },
]);
const sessions = await target.request(
  `${scope}/chat/sessions?environmentId=${environment.id}`,
);
const conversation = await target.request(
  `/chat/sessions/${sessions.items[0].id}`,
);
const read = await target.waitRun(conversation.runs[0].id, "completed", true);
record.readRunId = read.run.id;
assert.ok(toolSucceeded(read, "jira_read_issue"));
assert.ok(
  read.events.filter(
    (event: any) =>
      event.kind === "intervention" && event.data.status === "waiting",
  ).length >= 2,
  "未登录直接继续后应再次要求接管",
);
let jira = await target.request(`${scope}/jira`);
const issue = jira.issues.find((item: any) => item.issue_key === "DEMO-1");
assert.ok(issue?.description.includes("Echo chat"));
assert.ok(issue.acceptance.includes("jira-hello"));
assert.equal(jira.cases.length, 0);
record.issueId = issue.id;
console.log(
  "PASS Jira UI enters chat; unauthenticated resume stays paused; real browser snapshot saved",
);

const title = `Echo Jira 用例 ${stamp}`;
const casesResult = await ask(
  "cases_only",
  `请根据已保存的 Jira DEMO-1（${issueUrl}）需求，创建且只创建一条标题为「${title}」的测试用例，并关联该 Ticket。包含页面上的验收条件，按步骤列出操作和预期结果。本轮只保存用例。`,
);
assert.ok(toolSucceeded(casesResult, "save_test_case"));
noExecution(casesResult);
jira = await target.request(`${scope}/jira`);
assert.equal(jira.cases.length, 1);
const testCase = jira.cases[0];
assert.equal(testCase.jira_issue_id, issue.id);
assert.equal(testCase.version, 1);
assert.equal(
  (
    await target.request(
      `${scope}/resources/flows?environmentId=${environment.id}`,
    )
  ).total,
  0,
);
const manualMarker = `人工确认 ${stamp}：须检查完整回复 Echo: jira-hello，并保留截图。`;
const instructions = `${testCase.instructions}\n\n${manualMarker}`;
await ui("管理 Jira 关联用例并人工修改版本", "jira_ui_edit", [
  { action: "navigate", url: jiraPath },
  {
    action: "assertText",
    selector: 'tr:has-text("DEMO-1")',
    text: "Verify Echo chat basic usability",
  },
  {
    action: "click",
    selector: 'tr:has-text("DEMO-1") button:has-text("查看需求")',
  },
  { action: "assertText", selector: '[role="dialog"]', text: title },
  { action: "screenshot", name: "jira-story-cases.png" },
  { action: "navigate", url: `${scope}/cases?env=${environment.id}` },
  {
    action: "click",
    selector: `tr:has-text("${title}") button:has-text("编辑")`,
  },
  { action: "assertText", selector: '[role="dialog"]', text: "DEMO-1" },
  { action: "fill", selector: "textarea#instructions", value: instructions },
  { action: "click", selector: '[role="dialog"] button:has-text("保存")' },
  { action: "waitForHidden", selector: ".ant-modal-content" },
  { action: "assertText", selector: `tr:has-text("${title}")`, text: "v2" },
  {
    action: "click",
    selector: `tr:has-text("${title}") button:has-text("版本历史")`,
  },
  { action: "assertText", selector: '[role="dialog"]', text: manualMarker },
  { action: "assertText", selector: '[role="dialog"]', text: "v1" },
  { action: "screenshot", name: "jira-case-versions.png" },
]);
const versions = await target.request(`${scope}/cases/${testCase.id}/versions`);
assert.deepEqual(
  versions.map((version: any) => version.version),
  [2, 1],
);
assert.ok(versions[0].instructions.includes(manualMarker));
record.caseId = testCase.id;
console.log(
  "PASS cases-only stage, manual UI edits, Jira association, immutable case history",
);

const composed = await ask(
  "save_only",
  `请读取项目测试用例 ${testCase.id} 当前保存版本，保留人工补充要求，调查实际被测页面并生成可复用节点和流程。只保存测试脚本，本轮不要运行；使用 save_flow，之后由我单独执行。`,
  testCase.id,
);
assert.ok(toolSucceeded(composed, "read_test_case"));
assert.ok(toolSucceeded(composed, "save_flow"));
noExecution(composed);
const saved = (
  await target.request(
    `${scope}/resources/flows?environmentId=${environment.id}`,
  )
).items.find((item: any) => item.case_id === testCase.id);
assert.ok(saved);
assert.equal(saved.case_version, 2);
assert.equal(saved.current_case_version, 2);
assert.equal(
  (
    await target.request(
      `${scope}/resources/runs?environmentId=${environment.id}&pageSize=100`,
    )
  ).items.filter(
    (item: any) => item.mode === "execute" && item.flow_id === saved.id,
  ).length,
  0,
);
record.flowId = saved.id;
console.log(
  "PASS new conversation reads manual version and saves a flow without replay",
);

const executed = await ask(
  "execute_only",
  `请只运行现有测试流程 ${saved.id}，查看真实执行结果并向我报告。不重新生成流程，不更新 Jira。`,
);
assert.ok(toolSucceeded(executed, "run_flow"));
const execution = executed.events.find(
  (event: any) => event.kind === "flow_execution",
);
assert.ok(execution?.data.runId);
const replay = await target.waitRun(execution.data.runId, "passed");
assert.equal(replay.run.flow_id, saved.id);
assert.ok(
  replay.events.some(
    (event: any) =>
      event.kind === "step" &&
      event.data.status === "passed" &&
      event.data.step?.action === "assertText",
  ),
);
assert.ok(replay.artifacts.length > 0, "人工补充的截图要求应由流程执行并留证");
record.executionRunId = replay.run.id;
console.log(
  "PASS separate execution records actual assertions and screenshots",
);

await fetch(`${fixtureUrl}/control?expireSubmit`);
const published = await ask(
  "publish_only",
  `请将运行 ${replay.run.id} 的真实测试结果回写到 Jira ${issueUrl}，并在网页核对已保存的评论。本轮只回写结果。`,
);
assert.ok(toolSucceeded(published, "jira_publish_result"));
assert.ok(
  published.events.some(
    (event: any) =>
      event.kind === "intervention" && event.data.status === "waiting",
  ),
  "提交后会话过期应要求人工重新登录",
);
let fixture: any = await (await fetch(`${fixtureUrl}/control`)).json();
assert.equal(fixture.comments.length, 1);
assert.ok(fixture.comments[0].includes(`[LoopLab run ${replay.run.id}]`));
const duplicate = await ask(
  "publish_retry",
  `请再次核对并回写运行 ${replay.run.id} 到 Jira ${issueUrl}。已有相同运行标记时保留原评论，不重复新增。`,
);
assert.ok(
  duplicate.events.some(
    (event: any) =>
      event.kind === "jira_published" && event.data.alreadyPublished,
  ),
);
fixture = await (await fetch(`${fixtureUrl}/control`)).json();
assert.equal(fixture.comments.length, 1);
const transitioned = await ask(
  "transition_only",
  `请将 Jira ${issueUrl} 状态调整为 Done，选择页面的 Done 操作，完成后核对真实状态。`,
);
assert.ok(toolSucceeded(transitioned, "jira_transition"));
fixture = await (await fetch(`${fixtureUrl}/control`)).json();
assert.equal(fixture.status, "Done");
console.log(
  "PASS cross-chat factual publish, logout recovery, duplicate suppression and independent transition",
);

jira = await target.request(`${scope}/jira`);
await fetch(`${fixtureUrl}/control?changedTitle=true`);
await target.request(`${scope}/jira/sites`, "PUT", {
  origin: fixtureUrl,
  allowedOrigins: [],
  script: { ...jira.defaultScript, title: "#missing-title" },
});
const repaired = await ask(
  "repair_adapter",
  `重新读取 Jira ${issueUrl} 的最新需求。站点页面结构刚发生变化；如果读取脚本缺字段或失败，请调查当前真实元素，修复需要变更的站点定位字段，再重新读取验收。不要修改用例或运行流程。`,
);
assert.ok(toolSucceeded(repaired, "save_jira_adapter"));
assert.ok(toolSucceeded(repaired, "jira_read_issue"));
jira = await target.request(`${scope}/jira`);
assert.ok(jira.adapters[0].revision >= 2);
assert.notEqual(jira.adapters[0].script.title, "#missing-title");
assert.equal(jira.issues[0].title, "Verify Echo chat basic usability");
assert.equal(jira.cases[0].version, 2);
await ui("查看 Jira 回写与站点脚本", "jira_ui_results", [
  { action: "navigate", url: jiraPath },
  { action: "assertText", selector: 'tr:has-text("DEMO-1")', text: "Done" },
  { action: "click", selector: '[role="tab"]:has-text("回写记录")' },
  {
    action: "assertText",
    selector: '[role="tabpanel"]:visible',
    text: "已核验",
  },
  {
    action: "assertText",
    selector: '[role="tabpanel"]:visible',
    text: "回写测试结果",
  },
  { action: "screenshot", name: "jira-publications.png" },
  { action: "click", selector: '[role="tab"]:has-text("站点脚本")' },
  {
    action: "assertText",
    selector: '[role="tabpanel"]:visible',
    text: fixtureUrl,
  },
  { action: "screenshot", name: "jira-site-adapter.png" },
]);
Object.assign(record, {
  loginCount,
  publicationCount: jira.publications.length,
  adapterRevision: jira.adapters[0].revision,
  status: "passed",
});
await checkpoint();
console.log(
  "PASS Jira selectors are repaired from real page investigation; management UI shows verified records",
);
