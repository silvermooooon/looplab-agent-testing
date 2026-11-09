import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
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
const stamp = Date.now().toString(36);
const marker = () => randomBytes(8).toString("hex");

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
    const result: any = await response.json();
    assert.equal(
      response.status,
      200,
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
      await setTimeout(1400);
    }
    throw new Error(`运行超时：${id}`);
  }
}

const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
assert.equal((await target.request("/health")).database, true);
const targetUser = {
  name: "知识库自举账号",
  email: `knowledge-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
await target.request("/auth/register", "POST", targetUser);
const project = await target.request("/projects", "POST", {
  name: `知识库自举目标 ${stamp}`,
});
const projectPath = `/projects/${project.id}`;
const environment = await target.request(
  `${projectPath}/environments`,
  "POST",
  {
    name: "开发环境",
    baseUrl: targetUrl,
  },
);

async function ask(sessionId: string, text: string) {
  const { runId } = await target.request(
    `/chat/sessions/${sessionId}/messages`,
    "POST",
    { text, clientId: randomUUID() },
  );
  console.log(`Agent run ${runId}`);
  const result = await target.waitRun(runId, "completed");
  const { messages } = await target.request(`/chat/sessions/${sessionId}`);
  const reply = messages.find(
    (message: any) => message.run_id === runId && message.role === "assistant",
  );
  assert.ok(reply?.content, "助手回复没有保存");
  return { runId, events: result.events, reply: reply.content as string };
}

const olderTitle = `操作手册 ${stamp}`;
const olderMarker = `ARCHIVE-${marker()}`;
const older = await target.request(`${projectPath}/knowledge`, "POST", {
  title: olderTitle,
  content: `# 操作手册\n${"验收前置说明。\n".repeat(100)}${"x".repeat(10_100)}\n最终验收标记：${olderMarker}`,
});
for (let i = 1; i <= 7; i++)
  await target.request(`${projectPath}/knowledge`, "POST", {
    title: `验收背景 ${i}`,
    content: `这是第 ${i} 条项目背景。`,
  });
const defaultTitle = `项目基准 ${stamp}`;
const defaultMarker = `DEFAULT-${marker()}`;
await target.request(`${projectPath}/knowledge`, "POST", {
  title: defaultTitle,
  content: `# 项目基准\n本项目的基准标记：${defaultMarker}`,
});
const experienceTitle = `调试路径经验 ${stamp}`;
const experiencePath = `/debug/${marker()}`;
const initialSession = await target.request(
  `${projectPath}/chat/sessions`,
  "POST",
  {
    environmentId: environment.id,
    title: "整理调试经验",
  },
);
const initial = await ask(
  initialSession.id,
  `这次验收观察到调试页路径是 ${experiencePath}。请在回复中总结这条经验，并附上「${defaultTitle}」的基准标记。仅使用当前已提供的项目背景，不调用任何工具。`,
);
assert.ok(
  initial.reply.includes(defaultMarker),
  "Agent 没有使用默认加载的知识",
);
assert.ok(initial.reply.includes(experiencePath));
assert.ok(
  initial.events.some(
    (event: any) =>
      event.kind === "knowledge_loaded" &&
      event.data.count === 8 &&
      event.data.hasMore,
  ),
  "默认加载应有文档数量上限，并标识尚有更多文档",
);
assert.ok(
  !initial.events.some((event: any) => event.kind === "agent_tool_start"),
  "默认加载验证不能依赖主动调用工具",
);
assert.equal((await target.request(projectPath)).knowledge.length, 9);
console.log(
  "PASS project knowledge is loaded by default without creating documents",
);

const olderSession = await target.request(
  `${projectPath}/chat/sessions`,
  "POST",
  {
    environmentId: environment.id,
    title: "检索较早文档",
  },
);
const found = await ask(
  olderSession.id,
  `请用 list_knowledge 查找标题为「${olderTitle}」的文档，再用 read_knowledge 读取正文。若返回 nextOffset，请直接用它作为 offset 继续读下一页，无需询问。最后只回复文档末尾的完整最终验收标记。`,
);
assert.ok(found.reply.includes(olderMarker), "没有读取到较早文档的末尾");
assert.ok(
  found.events.some(
    (event: any) =>
      event.kind === "agent_tool_end" &&
      event.data.name === "list_knowledge" &&
      !event.data.isError,
  ),
  "没有通过项目知识检索工具定位文档",
);
assert.ok(
  found.events.some(
    (event: any) =>
      event.kind === "agent_tool_start" &&
      event.data.name === "read_knowledge" &&
      event.data.args.id === older.id &&
      event.data.args.offset > 0,
  ),
  "没有按文档 ID 继续读取下一页正文",
);
console.log("PASS the Agent can search and read beyond default context");

const controllerProject = await controller.request("/projects", "POST", {
  name: `知识库自举工作台 ${stamp}`,
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
  title: "从对话沉淀知识并打开文档",
  instructions:
    "在独立实例的对话中保存当前经验为 Markdown 知识文档，并在知识库核对正文。",
});
const chatUrl = `${projectPath}/agent?env=${environment.id}&chat=${initialSession.id}`;
const composer = 'textarea[placeholder="描述测试目标，或继续讨论与修改…"]';
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
  { action: "waitFor", selector: 'h2:has-text("项目管理")', timeoutMs: 20_000 },
  { action: "navigate", url: chatUrl },
  {
    action: "assertText",
    selector: ".ant-bubble-start .chat-markdown",
    text: defaultMarker,
    timeoutMs: 20_000,
  },
  {
    action: "click",
    selector:
      'button[aria-label="沉淀到知识库"], button:has-text("沉淀到知识库")',
  },
  { action: "waitFor", selector: `${composer}:not(:placeholder-shown)` },
  {
    action: "fill",
    selector: composer,
    value: `请将刚才确认的调试页路径保存到当前项目知识库。文档标题请使用「${experienceTitle}」，正文用 Markdown 的 ## 验证方法 标题和一条包含原样路径的列表项。保存后告诉我。`,
  },
  { action: "click", selector: 'button[aria-label="发送消息"]' },
  {
    action: "assertText",
    selector: ":nth-match(.ant-bubble-start, 2) .ant-tag",
    text: "已回复",
    timeoutMs: 150_000,
  },
  {
    action: "click",
    selector: `.chat-events a:has-text("${experienceTitle}")`,
  },
  {
    action: "assertText",
    selector: `tr:has-text("${experienceTitle}")`,
    text: experienceTitle,
    timeoutMs: 20_000,
  },
  {
    action: "click",
    selector: `tr:has-text("${experienceTitle}") button:has-text("阅读")`,
  },
  { action: "assertText", selector: '[role="dialog"]', text: experiencePath },
  { action: "screenshot", name: "saved-knowledge.png" },
];
const node = await controller.request(`${controllerPath}/nodes`, "POST", {
  environmentId: controllerEnvironment.id,
  key: "save_chat_experience",
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
const { runs } = await target.request(`/chat/sessions/${initialSession.id}`);
const saveRun = runs.find((run: any) => run.id !== initial.runId);
assert.ok(saveRun, "浏览器没有发送写入知识库的请求");
const saved = await target.waitRun(saveRun.id, "completed");
const stored = (await target.request(projectPath)).knowledge.filter(
  (document: any) => document.title === experienceTitle,
);
assert.equal(stored.length, 1, "应保存一份标题匹配的知识文档");
assert.match(stored[0].content, /^## 验证方法$/m);
assert.ok(stored[0].content.includes(experiencePath));
assert.ok(
  saved.events.some(
    (event: any) =>
      event.kind === "knowledge_saved" &&
      event.data.id === stored[0].id &&
      event.data.action === "created",
  ),
  "没有收到实际保存知识的事件",
);
console.log(
  "PASS a chat request saved Markdown that is readable in the knowledge UI",
);

const otherEnvironment = await target.request(
  `${projectPath}/environments`,
  "POST",
  {
    name: "预发布环境",
    baseUrl: targetUrl,
  },
);
const freshSession = await target.request(
  `${projectPath}/chat/sessions`,
  "POST",
  {
    environmentId: otherEnvironment.id,
    title: "新会话复用经验",
  },
);
const fresh = await ask(
  freshSession.id,
  `请只用已自动加载的当前项目知识，回复「${experienceTitle}」中记录的调试页路径。不要调用工具。`,
);
assert.ok(
  fresh.reply.includes(experiencePath),
  "新环境的新会话无法复用已保存经验",
);
assert.ok(
  !fresh.events.some((event: any) => event.kind === "agent_tool_start"),
);
console.log(
  "PASS a fresh chat in another environment reuses the saved experience",
);

const updateNote = `观察补充：调试页首次加载会显示状态 ${marker()}。`;
const updated = await ask(
  freshSession.id,
  `请先用 read_knowledge 读取现有知识文档 ${stored[0].id}。更新同一份文档「${experienceTitle}」，保留标题和原正文，只在末尾追加一条 Markdown 列表项：${updateNote}。请用 save_knowledge 的 id 参数提交更新，不另建文档。`,
);
const revised = (await target.request(projectPath)).knowledge.filter(
  (document: any) => document.title === experienceTitle,
);
assert.equal(revised.length, 1, "更新经验时创建了重复知识文档");
assert.equal(revised[0].id, stored[0].id);
assert.ok(revised[0].content.startsWith(stored[0].content.trimEnd()));
assert.ok(revised[0].content.includes(updateNote));
assert.ok(
  updated.events.some(
    (event: any) =>
      event.kind === "knowledge_saved" &&
      event.data.id === stored[0].id &&
      event.data.action === "updated",
  ),
  "没有收到实际更新知识的事件",
);
console.log(
  "PASS the Agent updates the existing document and preserves the original content",
);

const otherProject = await target.request("/projects", "POST", {
  name: `知识隔离对照 ${stamp}`,
});
const otherPath = `/projects/${otherProject.id}`;
const isolatedEnvironment = await target.request(
  `${otherPath}/environments`,
  "POST",
  {
    name: "隔离环境",
    baseUrl: targetUrl,
  },
);
const isolatedSession = await target.request(
  `${otherPath}/chat/sessions`,
  "POST",
  {
    environmentId: isolatedEnvironment.id,
    title: "项目知识隔离",
  },
);
const isolated = await ask(
  isolatedSession.id,
  `请检查当前项目的知识范围，必须执行下面两个实际工具调用后再回复，不要使用 report_progress。先调用 read_knowledge，参数为 {"id":"${stored[0].id}"}。即使读取失败也继续调用 list_knowledge，参数为 {"search":"${experienceTitle}"}。只根据这两个工具的结果回复能否找到文档。`,
);
assert.ok(
  !isolated.reply.includes(experiencePath),
  "其他项目读取到了隔离的知识",
);
assert.ok(
  isolated.events.some(
    (event: any) =>
      event.kind === "agent_tool_end" &&
      event.data.name === "read_knowledge" &&
      event.data.isError &&
      event.data.result[0].text.includes("知识文档不存在或不属于当前项目"),
  ),
  "读取其他项目的文档应被服务端拒绝",
);
const isolatedSearch = isolated.events.find(
  (event: any) =>
    event.kind === "agent_tool_end" &&
    event.data.name === "list_knowledge" &&
    !event.data.isError,
);
assert.ok(isolatedSearch, "没有实际检索当前项目的知识");
assert.deepEqual(JSON.parse(isolatedSearch.data.result[0].text).items, []);
assert.equal((await target.request(otherPath)).knowledge.length, 0);
console.log(
  "PASS project knowledge is isolated even for a shared project owner",
);

await mkdir(".data", { recursive: true });
await writeFile(
  ".data/self-test-knowledge-result.json",
  JSON.stringify(
    {
      projectId: project.id,
      environmentId: environment.id,
      documentId: stored[0].id,
      sessionId: initialSession.id,
      initialRunId: initial.runId,
      retrievalRunId: found.runId,
      savedRunId: saveRun.id,
      freshRunId: fresh.runId,
      updatedRunId: updated.runId,
      isolatedRunId: isolated.runId,
      browserRunId: replay.id,
    },
    null,
    2,
  ),
);
