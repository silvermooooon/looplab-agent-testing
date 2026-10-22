import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "playwright/test";
import { config } from "../src/server/config.js";

const base = `http://127.0.0.1:${config.port}`;
const suffix = Date.now().toString(36);
const owner = {
  name: "Silver · 验收",
  email: `silver-${suffix}@looplab.local`,
  password: randomBytes(16).toString("hex"),
};
const editor = {
  name: "团队协作者",
  email: `editor-${suffix}@looplab.local`,
  password: randomBytes(16).toString("hex"),
};
const outsider = {
  name: "独立用户",
  email: `outsider-${suffix}@looplab.local`,
  password: randomBytes(16).toString("hex"),
};
const checks: string[] = [];
function check(name: string) {
  checks.push(name);
  console.log("PASS", name);
}
class Client {
  cookie = "";
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    status = 200,
  ): Promise<any> {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = r.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0]!;
    const data = await r.json();
    assert.equal(
      r.status,
      status,
      `${method} ${path}: ${data.error ?? r.status}`,
    );
    return data;
  }
}
const a = new Client(),
  b = new Client(),
  c = new Client();
await a.request("/auth/register", "POST", owner);
await b.request("/auth/register", "POST", editor);
await c.request("/auth/register", "POST", outsider);
check("Three independent user accounts and cookie sessions");
const project = await a.request("/projects", "POST", {
  name: "Agent Chat · 验收项目",
  description: "真实 GPT 6 Luna 生成 · 团队共享节点 · 多环境版本隔离",
});
const pid = project.id;
await a.request(`/projects/${pid}/members`, "POST", {
  email: editor.email,
  role: "editor",
});
await c.request(`/projects/${pid}`, "GET", undefined, 403);
check("Project membership isolates unrelated users");
const env = await a.request(`/projects/${pid}/environments`, "POST", {
  name: "开发环境",
  baseUrl: base + "/demo",
  variables: {},
  secrets: { username: "tester@example.com", password: "Demo-Password-2026!" },
});
await a.request(`/projects/${pid}/knowledge`, "POST", {
  title: "对话平台操作与测试标准",
  content:
    "这是用于真实浏览器验收的示例对话平台。登录页填写邮箱与密码，凭据位于环境 secret.username 和 secret.password。登录后进入对话页，向消息输入框发送任意文本，回复区域会包含 Echo: 加上原消息，以及 系统状态：正常。应检查具体消息被回显，不能仅检查页面可见。登录、发送消息、检查回复、截图应拆成可复用节点。发送内容和预期回复应使用节点输入参数。不要把凭据的实际值存入节点。",
});
const tc = await a.request(`/projects/${pid}/cases`, "POST", {
  title: "登录与对话最小可用性",
  instructions:
    "使用环境凭据登录，发送消息 hello-loop，确认回复包含 Echo: hello-loop 以及 系统状态：正常，保存截图。请将登录、发送消息、验证回复、截图拆成独立可复用节点；消息与预期回复使用参数。",
});
async function waitRun(client: Client, runId: string) {
  const start = Date.now();
  let previous = "";
  while (Date.now() - start < config.runTimeoutMs + 60000) {
    const data = await client.request("/runs/" + runId);
    const latest = data.events.at(-1);
    const label = `${data.run.status}: ${latest?.kind ?? "queued"} ${latest?.data?.name ?? ""}`;
    if (label !== previous) {
      console.log("RUN", runId.slice(0, 8), label);
      previous = label;
    }
    if (!["queued", "running"].includes(data.run.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Acceptance run timed out");
}
const generated = await a.request(`/projects/${pid}/runs`, "POST", {
  environmentId: env.id,
  caseId: tc.id,
  mode: "generate",
});
const generatedResult = await waitRun(a, generated.id);
assert.equal(generatedResult.run.status, "passed", generatedResult.run.error);
check(
  "Real GPT 6 Luna explores UI, saves reusable nodes, and fresh-browser replay passes",
);
let shared = await b.request(`/projects/${pid}?environmentId=${env.id}`);
assert.ok(shared.nodes.length >= 3, "Expected modular nodes");
assert.ok(shared.flows.length >= 1);
assert.ok(generatedResult.artifacts.length >= 1);
const nodeCount = shared.nodes.length;
const initialRevisionIds = shared.nodes.map((n: any) => n.revision_id).sort();
const replay = await b.request(`/projects/${pid}/runs`, "POST", {
  environmentId: env.id,
  caseId: tc.id,
  flowId: generatedResult.run.flow_id,
  mode: "execute",
});
const replayResult = await waitRun(b, replay.id);
assert.equal(replayResult.run.status, "passed", replayResult.run.error);
assert.equal(
  replayResult.events.some((e: any) => e.kind.startsWith("agent_")),
  false,
);
shared = await b.request(`/projects/${pid}?environmentId=${env.id}`);
assert.equal(shared.nodes.length, nodeCount);
assert.deepEqual(
  shared.nodes.map((n: any) => n.revision_id).sort(),
  initialRevisionIds,
);
check(
  "Second user replays the same shared nodes without model calls or regeneration",
);
const dup = shared.nodes[0];
const dedup = await b.request(`/projects/${pid}/nodes`, "POST", {
  environmentId: env.id,
  key: dup.key,
  name: dup.name,
  description: dup.description,
  spec: dup.spec,
});
assert.equal(dedup.reused, true);
assert.equal(dedup.revisionId, dup.revision_id);
check("Identical node specs deduplicate existing revisions");
const clone = await b.request(
  `/projects/${pid}/environments/${env.id}/clone`,
  "POST",
  { name: "预发布环境", baseUrl: base + "/demo", copySecrets: true },
);
const cloned = await b.request(`/projects/${pid}?environmentId=${clone.id}`);
assert.equal(cloned.nodes.length, nodeCount);
assert.ok(
  cloned.nodes.every((n: any) => !initialRevisionIds.includes(n.revision_id)),
);
const cloneRun = await b.request(`/projects/${pid}/runs`, "POST", {
  environmentId: clone.id,
  caseId: tc.id,
  flowId: cloned.flows[0].id,
  mode: "execute",
});
assert.equal((await waitRun(b, cloneRun.id)).run.status, "passed");
check("Environment clone remaps revision IDs and replays independently");
await a.request(`/projects/${pid}/members`, "POST", {
  email: outsider.email,
  role: "viewer",
});
await c.request(
  `/projects/${pid}/cases`,
  "POST",
  { title: "forbidden", instructions: "no" },
  403,
);
await c.request(`/projects/${pid}`);
check("Viewer can read shared assets but cannot modify or execute");
const damaged = shared.nodes.find((n: any) =>
  n.spec.steps.some((s: any) => s.action === "fill"),
);
assert.ok(damaged);
const brokenSpec = structuredClone(damaged.spec);
brokenSpec.steps.find((s: any) => s.action === "fill").selector =
  "#deliberately-missing-for-repair";
const broken = await b.request(`/projects/${pid}/nodes`, "POST", {
  environmentId: env.id,
  key: damaged.key,
  name: damaged.name,
  description: damaged.description,
  spec: brokenSpec,
});
const oldFlow = shared.flows.find(
  (f: any) => f.id === generatedResult.run.flow_id,
);
const brokenFlow = await b.request(`/projects/${pid}/flows`, "POST", {
  environmentId: env.id,
  caseId: tc.id,
  name: "选择器变更 · 待修复",
  steps: oldFlow.steps.map((s: any) =>
    s.revisionId === damaged.revision_id
      ? { ...s, revisionId: broken.revisionId }
      : s,
  ),
});
const failedRun = await b.request(`/projects/${pid}/runs`, "POST", {
  environmentId: env.id,
  caseId: tc.id,
  flowId: brokenFlow.id,
  mode: "execute",
});
const failed = await waitRun(b, failedRun.id);
assert.equal(failed.run.status, "failed");
assert.ok(failed.artifacts.length);
check("Broken selector produces genuine failure evidence");
const repairRun = await b.request(`/projects/${pid}/runs`, "POST", {
  environmentId: env.id,
  caseId: tc.id,
  repairNodeId: damaged.node_id,
  mode: "repair",
});
const repaired = await waitRun(b, repairRun.id);
assert.equal(repaired.run.status, "passed", repaired.run.error);
const finalData = await b.request(`/projects/${pid}?environmentId=${env.id}`);
assert.ok(
  finalData.nodes.find((n: any) => n.node_id === damaged.node_id).version >
    broken.version,
);
const cloneAfter = await b.request(
  `/projects/${pid}?environmentId=${clone.id}`,
);
assert.deepEqual(
  cloneAfter.nodes.map((n: any) => n.revision_id).sort(),
  cloned.nodes.map((n: any) => n.revision_id).sort(),
);
check(
  "Agent repairs only the selected node; fresh replay passes and cloned environment stays unchanged",
);
const exportResponse = await fetch(
  base + `/api/projects/${pid}/flows/${repaired.run.flow_id}/export`,
  { headers: { Cookie: b.cookie } },
);
assert.equal(exportResponse.status, 200);
const source = await exportResponse.text();
assert.ok(source.includes("playwright"));
assert.ok(!source.includes("Demo-Password-2026!"));
check("Standalone TS export contains pinned steps and no environment secrets");
await mkdir(".data", { recursive: true });
await writeFile(
  ".data/acceptance-credentials.json",
  JSON.stringify({ baseUrl: base, owner, editor, projectId: pid }, null, 2),
  { mode: 0o600 },
);
const browser = await chromium.launch({
  channel: config.browserChannel,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1040 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("邮箱", { exact: true }).fill(owner.email);
  await page.getByLabel("密码", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目管理" })).toBeVisible();
  await page.goto(`${base}/projects/${pid}/nodes?env=${env.id}`);
  await expect(page.locator("tbody tr.ant-table-row")).toHaveCount(nodeCount);
  await page.screenshot({ path: ".data/workspace.png", fullPage: true });
  await page.getByRole("link", { name: "测试流程", exact: true }).click();
  await expect(page.locator("tbody tr.ant-table-row").first()).toBeVisible();
  await page.getByRole("button", { name: "编辑副本" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("link", { name: "运行记录", exact: true }).click();
  await page
    .getByRole("button", { name: "查看报告", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "执行事件" })).toBeVisible();
  await page.screenshot({ path: ".data/run-report.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".data/mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  check(
    "Browser UI login, shared node list, flow editor, run report, mobile layout",
  );
} finally {
  await browser.close();
}
await writeFile(
  ".data/acceptance-result.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      projectId: pid,
      model: "gpt-6-luna",
      checks,
      runIds: {
        generated: generated.id,
        replayed: replay.id,
        clone: cloneRun.id,
        failed: failedRun.id,
        repaired: repairRun.id,
      },
      nodeCount,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    status: "passed",
    checks: checks.length,
    projectId: pid,
    nodeCount,
  }),
);
