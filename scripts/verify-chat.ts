import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "playwright/test";
import { config } from "../src/server/config.js";
const base = `http://127.0.0.1:${config.port}`;
const credentials = JSON.parse(
  await readFile(".data/acceptance-credentials.json", "utf8"),
);
const browser = await chromium.launch({
  channel: config.browserChannel,
  headless: true,
});
const context = await browser.newContext({
    viewport: { width: 1680, height: 1100 },
  }),
  page = await context.newPage();
const failures: string[] = [],
  checks: string[] = [];
page.on("pageerror", (e) => failures.push(e.message));
const check = (name: string) => {
  checks.push(name);
  console.log("PASS", name);
};
const request = async (
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
) => {
  const r = await context.request.fetch(base + "/api" + path, {
    method,
    data: body,
  });
  const d = await r.json();
  assert.equal(
    r.status(),
    status,
    `${method} ${path}: ${d.error || r.status()}`,
  );
  return d;
};
async function wait(sid: string, rid: string) {
  let previous = "";
  const start = Date.now();
  while (Date.now() - start < config.runTimeoutMs + 30000) {
    const d = await request(`/chat/sessions/${sid}`);
    const r = d.runs.find((r: any) => r.id === rid);
    if (r.status !== previous) {
      console.log("RUN", r.status);
      previous = r.status;
    }
    if (r.events_complete) return d;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Run timed out");
}
try {
  await request("/auth/login", "POST", credentials.owner);
  const project = await request("/projects", "POST", {
      name: "Agent 对话 · 完整验收 " + Date.now().toString(36),
      description: "聊天、附件、实时事件、多轮编排与共享节点验收",
    }),
    pid = project.id;
  const env = await request(`/projects/${pid}/environments`, "POST", {
      name: "开发环境",
      baseUrl: base + "/demo",
      variables: {},
      secrets: {
        username: "tester@example.com",
        password: "Demo-Password-2026!",
      },
    }),
    eid = env.id;
  await request(`/projects/${pid}/knowledge`, "POST", {
    title: "对话平台测试说明",
    content:
      "使用 secret.username 和 secret.password 登录。登录后发送消息，回复包含 Echo: 原消息 和 系统状态：正常。登录、发送消息、检查回复、截图分别建立节点；消息和预期内容使用参数。",
  });
  await request(`/projects/${pid}/members`, "POST", {
    email: credentials.editor.email,
    role: "editor",
  });
  await page.goto(`${base}/projects/${pid}/agent?env=${eid}`);
  await expect(
    page.getByRole("heading", { name: "Agent 对话", exact: true }),
  ).toBeVisible();
  await mkdir(".data/screenshots/chat", { recursive: true });
  await page.screenshot({
    path: ".data/screenshots/chat/01-entry.png",
    fullPage: true,
  });
  const target = await context.newPage();
  await target.goto(base + "/demo");
  await target.getByRole("heading").first().waitFor();
  const png = await target.screenshot();
  await target.setContent("<h1>Test Review</h1><p>PDF audit code: 7319</p>");
  const pdf = await target.pdf();
  await target.close();
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "test-case.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "测试资料编号：4827。目标是登录、发送消息、检查 Echo 回显和系统状态正常。",
      ),
    },
    { name: "target-page.png", mimeType: "image/png", buffer: png },
    { name: "review.pdf", mimeType: "application/pdf", buffer: pdf },
  ]);
  await expect(page.locator(".chat-pending-files .ant-tag")).toHaveCount(3, {
    timeout: 20000,
  });
  const sid = new URL(page.url()).searchParams.get("chat")!;
  assert.ok(sid);
  await page.reload();
  await expect(page.locator(".chat-pending-files .ant-tag")).toHaveCount(3);
  check(
    "Multi-file UI upload creates session; unsent attachments survive refresh",
  );
  await page
    .getByPlaceholder("描述测试目标，或继续讨论与修改…")
    .fill(
      "请阅读三个附件，告诉我测试资料编号、PDF audit code 和截图中的登录页标题。这里只做资料确认，不打开浏览器，不生成或执行测试流程。",
    );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".chat-bubbles")).toContainText("这里只做资料确认");
  let initial = await request(`/chat/sessions/${sid}`);
  const rid = initial.runs[0].id;
  const cookie = (await context.cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  async function observe(id: string, after = 0) {
    const res = await fetch(
      `${base}/api/chat/sessions/${sid}/runs/${id}/stream?after=${after}`,
      {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(config.runTimeoutMs + 30000),
      },
    );
    assert.equal(res.status, 200);
    let buffer = "",
      all: any[] = [],
      packets: any[] = [];
    for await (const bytes of res.body!) {
      buffer += Buffer.from(bytes).toString();
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.includes("event: update")) {
          const p = JSON.parse(block.split("\ndata: ")[1]!);
          packets.push(p);
          all.push(...p.events);
        }
      }
    }
    return { all, packets };
  }
  const observed = await observe(rid),
    done = await wait(sid, rid);
  assert.equal(done.runs[0].status, "completed");
  assert.equal(done.runs[0].flow_id, null);
  const answer = done.messages.find((m: any) => m.role === "assistant").content;
  assert.match(answer, /4827/);
  assert.match(answer, /7319/);
  assert.match(answer, /登录|Login|Agent/);
  assert.ok(observed.all.some((e) => e.kind === "agent_text"));
  assert.ok(
    observed.packets.some(
      (p) =>
        p.run.status === "running" &&
        p.events.some((e: any) => e.kind === "agent_text"),
    ),
  );
  assert.ok(
    !observed.all.some(
      (e) => e.kind === "agent_tool_start" && e.data.name.startsWith("browser"),
    ),
  );
  check(
    "Real GPT 6 Luna reads text + screenshot + PDF and streams a reply without falsely marking a test pass",
  );
  await page.reload();
  await expect(page.locator(".chat-bubbles")).toContainText("7319");
  await page.screenshot({
    path: ".data/screenshots/chat/02-attachments.png",
    fullPage: true,
  });
  const body = {
    text: "现在按附件和项目知识开始测试：使用环境凭据登录，发送 chat-stream-4827，检查回复包含 Echo: chat-stream-4827 和 系统状态：正常，截图。先调查真实页面，把登录、发送消息、检查回复和截图保存为独立节点，再保存流程并执行验证。",
    attachmentIds: [],
    clientId: randomUUID(),
  };
  const sent = await request(`/chat/sessions/${sid}/messages`, "POST", body);
  const same = await request(`/chat/sessions/${sid}/messages`, "POST", body);
  assert.equal(same.runId, sent.runId);
  assert.equal(same.reused, true);
  await request(
    `/chat/sessions/${sid}/messages`,
    "POST",
    { text: "重复发送", clientId: randomUUID() },
    409,
  );
  check(
    "Message retries are idempotent; concurrent turns in one session are rejected",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible({
    timeout: 15000,
  });
  const flowObservation = observe(sent.runId);
  await page.screenshot({
    path: ".data/screenshots/chat/03-running.png",
    fullPage: true,
  });
  const flowDone = await wait(sid, sent.runId);
  assert.equal(flowDone.runs[0].status, "passed", flowDone.runs[0].error);
  assert.ok(flowDone.runs[0].flow_id);
  const nextAnswer = flowDone.messages.find(
    (m: any) => m.role === "assistant" && m.run_id === sent.runId,
  ).content;
  assert.ok(
    !nextAnswer.startsWith(answer.trim()),
    "Historical assistant reply must not be copied into the new turn",
  );
  assert.ok(flowDone.artifacts.length);
  const flowEvents = await flowObservation;
  assert.ok(
    flowEvents.all.some(
      (e) => e.kind === "agent_status" && e.data.stage === "testing",
    ),
  );
  assert.ok(flowEvents.all.some((e) => e.kind === "node_saved"));
  assert.ok(flowEvents.all.some((e) => e.kind === "run_passed"));
  const asset = await request(`/projects/${pid}?environmentId=${eid}`);
  assert.ok(asset.nodes.length >= 3);
  check(
    "Chat continuation generates modular nodes and a flow; independent Chrome replay and screenshot succeed",
  );
  const finalCursor = Number(flowEvents.all.at(-1).id),
    resume = await observe(sent.runId, finalCursor);
  assert.equal(resume.all.length, 0);
  check(
    "SSE resumes after its cursor without duplicated events and closes after final persistence",
  );
  await page.reload();
  await expect(page.locator(".chat-bubbles")).toContainText("测试验证通过");
  await expect(page.locator(".chat-status")).toContainText("已同步");
  await page.screenshot({
    path: ".data/screenshots/chat/04-result.png",
    fullPage: true,
  });
  const exportResponse = await context.request.get(
    `${base}/api/projects/${pid}/flows/${flowDone.runs[0].flow_id}/export`,
  );
  assert.equal(exportResponse.status(), 200);
  assert.match(await exportResponse.text(), /playwright/);
  const member = await browser.newContext();
  await member.request.post(base + "/api/auth/login", {
    data: credentials.editor,
  });
  const memberRead = await member.request.get(
    base + `/api/chat/sessions/${sid}`,
  );
  assert.equal(memberRead.status(), 200);
  assert.equal((await memberRead.json()).messages.length, 4);
  await member.close();
  check(
    "Another project editor sees the same conversation, attachments and generated assets; script export works",
  );
  const revised = await request(`/chat/sessions/${sid}/messages`, "POST", {
    text: "再生成一个流程：把消息改为 chat-reuse-7391，预期回显相应修改；复用刚刚保存的节点，不要创建节点新版本。保存并验证。",
    clientId: randomUUID(),
  });
  const reuse = await wait(sid, revised.runId);
  assert.equal(reuse.runs[0].status, "passed", reuse.runs[0].error);
  const after = await request(`/projects/${pid}?environmentId=${eid}`);
  assert.deepEqual(
    after.nodes.map((n: any) => n.revision_id).sort(),
    asset.nodes.map((n: any) => n.revision_id).sort(),
  );
  check(
    "A second conversational workflow reuses exact existing node revisions with new parameters",
  );
  await page.goto(`${base}/projects/${pid}/cases?env=${eid}`);
  await page.getByRole("button", { name: "与 Agent 生成" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Agent 对话", exact: true }),
  ).toBeVisible();
  check("Test-case generation redirects into the single Agent chat interface");
  const emptySid = new URL(page.url()).searchParams.get("chat")!;
  await request(`/chat/sessions/${emptySid}`, "PATCH", { archived: true });
  await request(
    `/chat/sessions/${emptySid}/messages`,
    "POST",
    { text: "禁止归档后执行", clientId: randomUUID() },
    409,
  );
  await request(`/chat/sessions/${emptySid}`, "PATCH", {
    archived: false,
    title: "用例入口验收",
  });
  const outsider = await browser.newContext();
  const outsiderUser = {
    name: "隔离验收",
    email: `chat-outsider-${Date.now()}@looplab.local`,
    password: randomBytes(16).toString("hex"),
  };
  await outsider.request.post(base + "/api/auth/register", {
    data: outsiderUser,
  });
  assert.equal(
    (await outsider.request.get(base + `/api/chat/sessions/${sid}`)).status(),
    403,
  );
  assert.equal(
    (
      await outsider.request.get(
        base + `/api/chat/attachments/${initial.messages[0].attachments[0].id}`,
      )
    ).status(),
    403,
  );
  await outsider.close();
  await request(`/projects/${pid}/members`, "POST", {
    email: credentials.editor.email,
    role: "viewer",
  });
  const viewer = await browser.newContext();
  await viewer.request.post(base + "/api/auth/login", {
    data: credentials.editor,
  });
  assert.equal(
    (
      await viewer.request.post(base + `/api/chat/sessions/${sid}/messages`, {
        data: { text: "viewer", clientId: randomUUID() },
      })
    ).status(),
    403,
  );
  await viewer.close();
  check(
    "Archived sessions, viewer writes and cross-project attachment access are enforced",
  );
  const stopping = await request(
    `/chat/sessions/${emptySid}/messages`,
    "POST",
    { text: "调查目标页面，然后生成测试。", clientId: randomUUID() },
  );
  await request(
    `/chat/sessions/${emptySid}/runs/${stopping.runId}/cancel`,
    "POST",
  );
  const stopped = await wait(emptySid, stopping.runId);
  assert.equal(stopped.runs[0].status, "cancelled");
  check("User can cancel a pending conversational run");
  await page.goto(`${base}/projects/${pid}/agent?env=${eid}&chat=${sid}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "执行动态", exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  );
  await page.getByRole("button", { name: "执行动态", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("执行动态");
  await page.screenshot({
    path: ".data/screenshots/chat/05-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  check(
    "Responsive mobile drawers work without overflow or browser runtime exceptions",
  );
  await writeFile(
    ".data/chat-acceptance-result.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        projectId: pid,
        environmentId: eid,
        sessionId: sid,
        runIds: [rid, sent.runId, revised.runId],
        checks,
      },
      null,
      2,
    ),
  );
  console.log("CHAT_ACCEPTANCE_OK", checks.length);
} finally {
  await browser.close();
}
