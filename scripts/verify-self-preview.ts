import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { chromium, type APIRequestContext } from "playwright";
import { config } from "../src/server/config.js";

const target = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
assert.notEqual(new URL(target).origin, `http://127.0.0.1:${config.port}`);
await mkdir(".data", { recursive: true });
const browser = await chromium.launch({ channel: config.browserChannel });
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>浏览器观察验收</title>
    <h1>浏览器观察验收</h1><button id="trigger" hidden>触发页面变化</button>
    <p id="done" hidden>浏览器点击已验证</p><script>
    const button = document.querySelector('#trigger');
    setTimeout(() => button.hidden = false, 5500);
    button.onclick = () => {
      document.body.style.background = '#b4f3c7';
      setTimeout(() => document.querySelector('#done').hidden = false, 5500);
    };
    </script>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(
  client: APIRequestContext,
  path: string,
  body?: unknown,
) {
  const response = await client.fetch(`${target}/api${path}`, {
    method: body ? "POST" : "GET",
    data: body,
  });
  const data = await response.json();
  assert.ok(response.ok(), `${path}: ${data.error ?? response.status()}`);
  return data;
}

async function waitRun(
  client: APIRequestContext,
  id: string,
  expected: string,
) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const { run } = await request(client, `/runs/${id}`);
    if (run.events_complete) {
      assert.equal(run.status, expected, run.error);
      return run;
    }
    await setTimeout(500);
  }
  throw new Error(`运行未结束：${id}`);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const client = context.request;
  const page = await context.newPage();
  const stamp = Date.now().toString(36);
  const user = {
    name: "实时浏览器验收",
    email: `preview-${stamp}@example.test`,
    password: randomBytes(24).toString("hex"),
  };
  await request(client, "/auth/register", user);
  const { id: pid } = await request(client, "/projects", {
    name: `实时浏览器 ${stamp}`,
  });
  const scope = `/projects/${pid}`;
  const { id: eid } = await request(client, `${scope}/environments`, {
    name: "验收环境",
    baseUrl,
  });
  const { id: sid } = await request(client, `${scope}/chat/sessions`, {
    environmentId: eid,
  });
  const preview = page.getByRole("dialog", { name: "实时浏览器" });
  const trigger = page.getByRole("button", { name: "实时浏览器", exact: true });
  let previewRequests = 0;
  page.on("request", (item) => {
    if (/\/api\/runs\/[^/]+\/preview$/.test(new URL(item.url()).pathname))
      previewRequests++;
  });
  async function observeClick(phase: string) {
    await trigger.click();
    await preview
      .getByRole("img", { name: "实时浏览器画面" })
      .waitFor({ timeout: 30_000 });
    await preview.getByText(phase, { exact: true }).waitFor();
    await preview
      .getByTestId("browser-preview-click")
      .waitFor({ timeout: 30_000 });
  }

  await page.goto(`${target}${scope}/agent?env=${eid}&chat=${sid}`);
  let acknowledged = false;
  const messagePath = `**/api/chat/sessions/${sid}/messages`;
  await page.route(messagePath, async (route) => {
    const response = await route.fetch();
    await setTimeout(1800);
    acknowledged = true;
    await route.fulfill({ response });
  });
  const text =
    "请只做实时浏览器调查。实际调用 browser_action 按顺序 navigate 到 /，点击 #trigger，再等待 #done 可见。然后用一句话报告观察结果。此轮只操作页面。";
  await page.getByPlaceholder("描述测试目标，或继续讨论与修改…").fill(text);
  await page.getByRole("button", { name: "发送消息" }).click();
  await page
    .locator(".ant-bubble-end")
    .getByText(text, { exact: true })
    .waitFor({ timeout: 1500 });
  await page.getByText("发送中", { exact: true }).waitFor({ timeout: 1500 });
  assert.equal(acknowledged, false, "消息应在收到服务端响应前出现在界面");
  console.log("PASS user message is visible before the delayed response");
  await observeClick("Agent 调查");
  await page.screenshot({ path: ".data/live-browser-agent.png" });
  const conversation = await request(client, `/chat/sessions/${sid}`);
  const chatRun = conversation.runs[0];
  await waitRun(client, chatRun.id, "completed");
  const messages = (await request(client, `/chat/sessions/${sid}`)).messages;
  assert.equal(
    messages.filter(
      (message: any) => message.role === "user" && message.content === text,
    ).length,
    1,
  );
  await page.unroute(messagePath);
  console.log(
    "PASS Agent investigation showed a live frame and an actual click",
  );

  const testCase = await request(client, `${scope}/cases`, {
    title: "观察独立重放点击",
    instructions: "点击按钮并等待结果出现",
  });
  const node = await request(client, `${scope}/nodes`, {
    environmentId: eid,
    key: "preview_click",
    name: "观察点击",
    spec: {
      inputs: [],
      steps: [
        { action: "click", selector: "#trigger" },
        { action: "waitFor", selector: "#done" },
        { action: "assertText", selector: "#done", text: "浏览器点击已验证" },
      ],
    },
  });
  const flow = await request(client, `${scope}/flows`, {
    environmentId: eid,
    caseId: testCase.id,
    name: "实时浏览器重放",
    steps: [{ revisionId: node.revisionId, params: {} }],
  });
  const replay = await request(client, `${scope}/runs`, {
    environmentId: eid,
    caseId: testCase.id,
    flowId: flow.id,
    mode: "execute",
  });
  await page.goto(`${target}${scope}/runs?env=${eid}&run=${replay.id}`);
  await observeClick("独立重放");
  await preview.locator(".ant-drawer-close").click();
  await preview.waitFor({ state: "hidden" });
  const requestsAfterClosing = previewRequests;
  await setTimeout(1400);
  assert.equal(previewRequests, requestsAfterClosing, "关闭画面后应停止请求帧");

  const stranger = await browser.newContext();
  await request(stranger.request, "/auth/register", {
    ...user,
    email: `preview-stranger-${stamp}@example.test`,
  });
  assert.equal(
    (
      await stranger.request.get(`${target}/api/runs/${replay.id}/preview`)
    ).status(),
    403,
  );
  await waitRun(client, replay.id, "passed");
  const ended = await client.get(`${target}/api/runs/${replay.id}/preview`);
  assert.equal(ended.status(), 204);
  assert.equal(ended.headers()["x-preview-state"], "ended");
  console.log(
    "PASS replay preview, close stops requests, and unauthorized access is denied",
  );
  await writeFile(
    ".data/self-test-preview-result.json",
    JSON.stringify(
      { pid, eid, sid, chatRunId: chatRun.id, replayRunId: replay.id },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  fixture.close();
}
