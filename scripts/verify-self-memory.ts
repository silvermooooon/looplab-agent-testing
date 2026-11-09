import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { config } from "../src/server/config.js";
import type { Step } from "../src/testing/spec.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
assert.notEqual(new URL(controllerUrl).origin, new URL(targetUrl).origin);
const { owner } = JSON.parse(
  await readFile(
    process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json",
    "utf8",
  ),
);
const stamp = randomBytes(6).toString("hex");
const prefix = `RPT-${stamp}`;
const projectMarker = `PROJECT-${randomBytes(6).toString("hex")}`;
const blank = { content: "", version: null };

class Client {
  private cookie = "";
  constructor(private readonly base: string) {}

  async request(path: string, method = "GET", body?: unknown, status = 200) {
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
    const result: any = await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${result.error || response.status}`,
    );
    return result;
  }

  async waitRun(id: string, status: "completed" | "passed") {
    const deadline = Date.now() + config.runTimeoutMs + 30_000;
    while (Date.now() < deadline) {
      const result = await this.request(`/runs/${id}`);
      if (result.run.events_complete) {
        assert.equal(result.run.status, status, result.run.error);
        return result;
      }
      await setTimeout(1000);
    }
    throw new Error(`运行超时：${id}`);
  }
}

const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
const teammate = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
assert.equal((await target.request("/health")).database, true);
await target.request("/me/memory", "GET", undefined, 401);

const targetUser = {
  name: "个人记忆自举账号",
  email: `memory-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
const teammateUser = {
  name: "个人记忆隔离账号",
  email: `memory-teammate-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
const { user } = await target.request("/auth/register", "POST", targetUser);
await teammate.request("/auth/register", "POST", teammateUser);
assert.deepEqual(await target.request("/me/memory"), blank);

async function createTargetProject(label: string) {
  const project = await target.request("/projects", "POST", {
    name: `个人记忆自举 ${label} ${stamp}`,
  });
  const path = `/projects/${project.id}`;
  const environment = await target.request(`${path}/environments`, "POST", {
    name: "开发环境",
    baseUrl: targetUrl,
  });
  return { id: project.id, path, environmentId: environment.id };
}

const first = await createTargetProject("甲");
const second = await createTargetProject("乙");
await target.request(`${second.path}/members`, "POST", {
  email: teammateUser.email,
  role: "editor",
});
const guideline = await target.request(`${second.path}/knowledge`, "POST", {
  title: "项目验收代号",
  content: `本项目的验收代号是 ${projectMarker}。`,
});

async function ask(
  client: Client,
  project: Awaited<ReturnType<typeof createTargetProject>>,
  text: string,
) {
  const session = await client.request(
    `${project.path}/chat/sessions`,
    "POST",
    {
      environmentId: project.environmentId,
      title: "验证个人记忆",
    },
  );
  const { runId } = await client.request(
    `/chat/sessions/${session.id}/messages`,
    "POST",
    {
      text,
      clientId: randomUUID(),
    },
  );
  console.log(`Agent run ${runId}`);
  const result = await client.waitRun(runId, "completed");
  const { messages } = await client.request(`/chat/sessions/${session.id}`);
  const reply = messages.find(
    (message: any) => message.run_id === runId && message.role === "assistant",
  );
  assert.ok(reply?.content, "助手回复没有保存");
  return {
    runId,
    events: result.events as any[],
    reply: reply.content as string,
  };
}

const remember = await ask(
  target,
  first,
  `请记住我的长期测试习惯：以后不论哪个项目，我请你写“一行测试摘要”时，都以 ${prefix} 作为摘要行开头。这是我个人跨项目的输出格式偏好。请保存并简短确认。`,
);
assert.ok(
  remember.events.some((event) => event.kind === "personal_memory_saved"),
  "未保存个人偏好",
);
const saveEvents = remember.events.filter(
  (event) => event.data?.name === "save_personal_memory",
);
assert.ok(saveEvents.some((event) => event.kind === "agent_tool_start"));
assert.ok(
  saveEvents.some(
    (event) => event.kind === "agent_tool_end" && !event.data.isError,
  ),
);
assert.ok(
  !JSON.stringify(saveEvents).includes(prefix),
  "共享工具事件泄漏了个人记忆正文",
);
assert.ok(
  !JSON.stringify(
    remember.events.filter((event) => event.kind === "personal_memory_saved"),
  ).includes(prefix),
);
const saved = await target.request("/me/memory");
assert.ok(saved.content.includes(prefix));
assert.match(saved.version, /^[a-f0-9]{40}$/);
assert.equal((await target.request(first.path)).knowledge.length, 0);
assert.deepEqual(await teammate.request("/me/memory"), blank);
console.log(
  "PASS a natural chat request saved personal memory separately from shared project knowledge",
);

const summary =
  "请按我平常的格式写一行测试摘要，说明页面加载成功，并附上当前项目的验收代号。请直接回复，不调用工具。";
const recalled = await ask(target, second, summary);
assert.ok(
  recalled.reply.includes(prefix),
  "同账号在另一个项目没有应用个人偏好",
);
assert.ok(recalled.reply.includes(projectMarker), "个人记忆不应替代项目知识");
assert.ok(
  recalled.events.some(
    (event) => event.kind === "personal_memory_loaded" && event.data.hasMemory,
  ),
);
assert.ok(!recalled.events.some((event) => event.kind === "agent_tool_start"));

const isolated = await ask(teammate, second, summary);
assert.ok(!isolated.reply.includes(prefix), "同项目其他成员读取到个人偏好");
assert.ok(isolated.reply.includes(projectMarker), "同项目成员没有收到项目知识");
assert.ok(
  isolated.events.some(
    (event) => event.kind === "personal_memory_loaded" && !event.data.hasMemory,
  ),
);
assert.deepEqual(await teammate.request("/me/memory"), blank);
assert.deepEqual(
  (await target.request(second.path)).knowledge.map(
    (document: any) => document.id,
  ),
  [guideline.id],
);
console.log(
  "PASS the same account recalls preferences in a fresh project, while a teammate sees only shared knowledge",
);

const controllerProject = await controller.request("/projects", "POST", {
  name: `个人记忆自举工作台 ${stamp}`,
});
const controllerPath = `/projects/${controllerProject.id}`;
const controllerEnvironment = await controller.request(
  `${controllerPath}/environments`,
  "POST",
  {
    name: "独立 LoopLab",
    baseUrl: targetUrl,
    secrets: { username: targetUser.email, password: targetUser.password },
  },
);
const testCase = await controller.request(`${controllerPath}/cases`, "POST", {
  title: "在账号入口管理个人记忆",
  instructions: "登录独立实例，从全局账号入口读取并保存个人测试偏好。",
});
const edited = `- 测试摘要优先展示失败项，使用 ${prefix}-EDIT 前缀。`;
const editor = 'textarea[aria-label="个人记忆内容"]';
const originalVersion = `[title="${saved.version}"]`;
const steps: Step[] = [
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
  { action: "click", selector: 'a[href="/memory"]' },
  { action: "assertValue", selector: editor, value: saved.content },
  { action: "assertVisible", selector: originalVersion },
  { action: "fill", selector: editor, value: edited },
  { action: "click", selector: 'button:has-text("保存个人记忆")' },
  { action: "waitForHidden", selector: originalVersion },
  { action: "reload" },
  { action: "assertValue", selector: editor, value: edited },
  { action: "screenshot", name: "personal-memory.png" },
];
const node = await controller.request(`${controllerPath}/nodes`, "POST", {
  environmentId: controllerEnvironment.id,
  key: "edit_personal_memory",
  name: testCase.title,
  spec: { inputs: [], steps },
});
const flow = await controller.request(`${controllerPath}/flows`, "POST", {
  environmentId: controllerEnvironment.id,
  caseId: testCase.id,
  name: testCase.title,
  steps: [{ revisionId: node.revisionId, params: {} }],
});
const replay = await controller.request(`${controllerPath}/runs`, "POST", {
  environmentId: controllerEnvironment.id,
  caseId: testCase.id,
  flowId: flow.id,
  mode: "execute",
});
console.log(`Browser run ${replay.id}`);
await controller.waitRun(replay.id, "passed");
const latest = await target.request("/me/memory");
assert.equal(latest.content, edited);
assert.notEqual(latest.version, saved.version);
await target.request(
  "/me/memory",
  "PUT",
  { content: edited, version: saved.version },
  409,
);
assert.deepEqual(await target.request("/me/memory"), latest);
assert.deepEqual(await target.request("/me/memory", "PUT", latest), latest);
const cleared = await target.request("/me/memory", "PUT", {
  content: "",
  version: latest.version,
});
assert.equal(cleared.content, "");
assert.notEqual(cleared.version, latest.version);
assert.deepEqual(await target.request("/me/memory"), cleared);
console.log(
  "PASS the real browser saves account memory, stale writes conflict, and clearing removes the active entry",
);

const afterClear = await ask(target, second, summary);
assert.ok(!afterClear.reply.includes(prefix));
assert.ok(afterClear.reply.includes(projectMarker));
assert.ok(
  afterClear.events.some(
    (event) => event.kind === "personal_memory_loaded" && !event.data.hasMemory,
  ),
);

const memoryRoot =
  process.env.SELF_TEST_TARGET_MEMORY_DIR ||
  process.env.LOOPLAB_PERSONAL_MEMORY_DIR ||
  ".data/personal-memory";
const repo = resolve(
  memoryRoot,
  `${createHash("sha256").update(user.id).digest("hex")}.git`,
);
const runGit = promisify(execFile);
async function git(...args: string[]) {
  return (await runGit("git", ["--git-dir", repo, ...args])).stdout;
}
assert.equal((await git("rev-parse", "--is-bare-repository")).trim(), "true");
assert.deepEqual(
  (await git("log", "refs/heads/main", "--format=%H")).trim().split("\n"),
  [cleared.version, latest.version, saved.version],
);
assert.equal(await git("show", `${saved.version}:MEMORY.md`), saved.content);
assert.equal(await git("show", `${latest.version}:MEMORY.md`), edited);
assert.equal(await git("show", `${cleared.version}:MEMORY.md`), "");
console.log(
  "PASS the private bare Git repository retains all three versions and a cleared preference is not loaded",
);

await mkdir(".data", { recursive: true });
await writeFile(
  ".data/self-test-memory-result.json",
  JSON.stringify(
    {
      status: "passed",
      targetProjectIds: [first.id, second.id],
      browserRunId: replay.id,
      agentRunIds: [
        remember.runId,
        recalled.runId,
        isolated.runId,
        afterClear.runId,
      ],
      revisions: [saved.version, latest.version, cleared.version],
    },
    null,
    2,
  ),
);
