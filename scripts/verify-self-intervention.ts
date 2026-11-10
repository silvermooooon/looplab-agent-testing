import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "playwright/test";
import { config } from "../src/server/config.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
assert.notEqual(controllerUrl, targetUrl, "工作台和目标必须使用独立实例");
const { owner } = JSON.parse(
  await readFile(
    process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json",
    "utf8",
  ),
);
const stamp = Date.now().toString(36);
class Client {
  private cookie = "";
  constructor(private base: string) {}
  async request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
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
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeout = 60000,
): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${label} timed out`);
}
async function waitRun(client: Client, id: string) {
  return waitFor(
    `run ${id}`,
    async () => {
      const result = await client.request(`/runs/${id}`);
      return result.run.events_complete ? result : undefined;
    },
    config.runTimeoutMs + 30000,
  );
}
async function waitIntervention(client: Client, id: string) {
  return waitFor(`intervention ${id}`, async () => {
    const state = await client.request(`/runs/${id}/intervention`);
    return state.active ? state : undefined;
  });
}
const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
const user = {
  name: "人工接管自举",
  email: `intervention-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
await target.request("/auth/register", "POST", user);
const project = await target.request("/projects", "POST", {
  name: `人工接管目标 ${stamp}`,
});
const environment = await target.request(
  `/projects/${project.id}/environments`,
  "POST",
  {
    name: "自举目标",
    baseUrl: targetUrl,
    variables: {},
    secrets: { username: user.email, password: user.password },
  },
);
async function makeFlow(
  client: Client,
  projectId: string,
  environmentId: string,
  key: string,
  steps: object[],
) {
  const testCase = await client.request(
    `/projects/${projectId}/cases`,
    "POST",
    { title: key, instructions: "端到端验证人工接管和事件监听" },
  );
  const node = await client.request(`/projects/${projectId}/nodes`, "POST", {
    environmentId,
    key,
    name: key,
    spec: { inputs: [], steps },
  });
  const flow = await client.request(`/projects/${projectId}/flows`, "POST", {
    environmentId,
    caseId: testCase.id,
    name: key,
    steps: [{ revisionId: node.revisionId, params: {} }],
  });
  return { testCase, flow };
}
async function start(
  client: Client,
  projectId: string,
  environmentId: string,
  fixture: { testCase: any; flow: any },
) {
  return client.request(`/projects/${projectId}/runs`, "POST", {
    environmentId,
    caseId: fixture.testCase.id,
    flowId: fixture.flow.id,
    mode: "execute",
  });
}
const login = [
  { action: "fill", selector: "#email", value: "{{secret.username}}" },
  { action: "fill", selector: "#password", value: "{{secret.password}}" },
  { action: "click", selector: 'button[type="submit"]' },
  { action: "waitFor", selector: 'h2:has-text("项目管理")', timeoutMs: 20000 },
];
const modalFlow = await makeFlow(
  target,
  project.id,
  environment.id,
  "watch_modal",
  [
    ...login,
    {
      action: "watchElement",
      selector: '[role="dialog"]',
      message: "请关闭创建项目弹窗",
    },
    { action: "click", selector: 'button:has-text("创建项目")' },
    { action: "waitForHidden", selector: '[role="dialog"]', timeoutMs: 20000 },
    { action: "assertText", selector: "h2", text: "项目管理" },
  ],
);
const modalRun = await start(target, project.id, environment.id, modalFlow);
const modalPause = await waitIntervention(target, modalRun.id);
assert.match(modalPause.info.message, /关闭创建项目弹窗/);
assert.equal(
  (await target.request(`/runs/${modalRun.id}`)).run.status,
  "running",
);

// The outer LoopLab run operates the paused target's real browser through its UI.
const outerProject = await controller.request("/projects", "POST", {
  name: `人工接管自举工作台 ${stamp}`,
});
const outerEnvironment = await controller.request(
  `/projects/${outerProject.id}/environments`,
  "POST",
  {
    name: "独立 LoopLab",
    baseUrl: targetUrl,
    variables: {},
    secrets: { username: user.email, password: user.password },
  },
);
const outerFlow = await makeFlow(
  controller,
  outerProject.id,
  outerEnvironment.id,
  "handoff_ui",
  [
    ...login,
    {
      action: "navigate",
      url: `/projects/${project.id}/runs?env=${environment.id}&run=${modalRun.id}`,
    },
    {
      action: "assertText",
      selector: '[aria-label="人工接管"]',
      text: "请关闭创建项目弹窗",
      timeoutMs: 30000,
    },
    {
      action: "assertVisible",
      selector: 'img[aria-label="接管画面"]',
      timeoutMs: 30000,
    },
    { action: "assertVisible", selector: 'input[aria-label="按键"]' },
    { action: "click", selector: 'button[aria-label="发送按键"]' },
    { action: "click", selector: 'button[aria-label="继续运行"]' },
    {
      action: "waitForHidden",
      selector: '[aria-label="人工接管"]',
      timeoutMs: 30000,
    },
    { action: "screenshot", name: "handoff-ui" },
  ],
);
const outerRun = await start(
  controller,
  outerProject.id,
  outerEnvironment.id,
  outerFlow,
);
const outerResult = await waitRun(controller, outerRun.id);
assert.equal(outerResult.run.status, "passed", outerResult.run.error);
const modalResult = await waitRun(target, modalRun.id);
assert.equal(modalResult.run.status, "passed", modalResult.run.error);
assert.ok(outerResult.artifacts.length, "未保存人工接管 UI 截图");
console.log(
  "PASS element watcher, live browser UI operation and resumed execution",
);

const responseFlow = await makeFlow(
  target,
  project.id,
  environment.id,
  "watch_response",
  [
    {
      action: "watchResponse",
      url: "/api/auth/login",
      message: "登录响应已发生",
    },
    ...login,
    { action: "assertText", selector: "h2", text: "项目管理" },
  ],
);
const responseRun = await start(
  target,
  project.id,
  environment.id,
  responseFlow,
);
const responsePause = await waitIntervention(target, responseRun.id);
assert.match(responsePause.info.message, /登录响应/);
await target.request(`/runs/${responseRun.id}/intervention/actions`, "POST", {
  type: "resume",
});
const responseResult = await waitRun(target, responseRun.id);
assert.equal(responseResult.run.status, "passed", responseResult.run.error);
console.log("PASS response watcher catches an event during a later step");

const fixtureServer = createServer((request, reply) => {
  reply.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/keyboard") {
    reply.end(`<!doctype html><title>接管键盘验收</title>
      <form onsubmit="event.preventDefault(); document.querySelector('#submitted').textContent='Enter 已提交'">
        <input id="first" aria-label="第一项" style="position:absolute;left:40px;top:40px;width:200px">
        <input id="second" type="password" aria-label="密码" style="position:absolute;left:40px;top:80px;width:200px">
        <button type="submit" style="position:absolute;left:40px;top:120px">提交</button>
      </form>
      <p id="submitted" style="position:absolute;left:40px;top:150px">等待提交</p>`);
    return;
  }
  reply.end(
    `<!doctype html><title>Dialog fixture</title><button id="open" onclick="alert('需要人工确认');document.querySelector('#result').textContent='已确认'">打开浏览器弹框</button><button id="start" onclick="setTimeout(()=>document.querySelector('#block').hidden=false,700)">开始异步操作</button><button id="network" onclick="setTimeout(()=>fetch('/fixture-response'),700)">发送请求</button><div id="result">尚未确认</div><div id="block" hidden style="position:fixed;top:100px;left:20px"><button onclick="document.querySelector('#done').hidden=false;document.querySelector('#block').hidden=true">处理并继续</button></div><div id="done" hidden>已完成</div>`,
  );
});
await new Promise<void>((resolve) =>
  fixtureServer.listen(0, "127.0.0.1", resolve),
);
let keyboardRunId: string;
try {
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== "string");
  const fixtureEnvironment = await target.request(
    `/projects/${project.id}/environments`,
    "POST",
    {
      name: "人工接管验收网页",
      baseUrl: `http://127.0.0.1:${address.port}`,
      variables: {},
    },
  );
  const keyboardFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "takeover_keyboard",
    [
      { action: "navigate", url: "/keyboard" },
      { action: "pauseForHuman", message: "请直接操作接管画面中的表单" },
      { action: "assertValue", selector: "#first", value: "a中x粘贴😀" },
      { action: "assertValue", selector: "#second", value: "next" },
      { action: "assertText", selector: "#submitted", text: "Enter 已提交" },
    ],
  );
  const keyboardRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    keyboardFlow,
  );
  keyboardRunId = keyboardRun.id;
  await waitIntervention(target, keyboardRunId);

  const browser = await chromium.launch({ channel: config.browserChannel });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.goto(
      `${targetUrl}/projects/${project.id}/runs?env=${fixtureEnvironment.id}&run=${keyboardRunId}`,
    );
    await page.locator("#email").fill(user.email);
    await page.locator("#password").fill(user.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const panel = page.getByLabel("人工接管", { exact: true });
    const image = panel.getByRole("img", { name: "接管画面" });
    await expect(image).toBeVisible({ timeout: 30000 });
    const position = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      await img.decode();
      return {
        x: (100 * img.clientWidth) / img.naturalWidth,
        y: (51 * img.clientHeight) / img.naturalHeight,
      };
    });
    await image.click({ position });
    const capture = panel.getByLabel("接管浏览器键盘");
    await expect(capture).toBeFocused();
    await page.keyboard.type("abx");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    const ime = await context.newCDPSession(page);
    await ime.send("Input.imeSetComposition", {
      text: "zhong",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await ime.send("Input.imeSetComposition", {
      text: "中",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await ime.send("Input.insertText", { text: "中" });
    await page.keyboard.press("End");
    await page.evaluate(() => navigator.clipboard.writeText("粘贴😀"));
    await page.keyboard.press("ControlOrMeta+V");
    await page.keyboard.press("Tab");
    await page.keyboard.type("replace");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("next");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Escape");
    await expect(capture).not.toBeFocused();
    await page.keyboard.type("ignored");
    await panel.getByRole("button", { name: "继续运行" }).click();
    await expect(panel).toBeHidden({ timeout: 30000 });
    const result = await waitRun(target, keyboardRunId);
    assert.equal(result.run.status, "passed", result.run.error);
    console.log(
      "PASS live takeover receives direct text, IME, paste, editing keys, Tab and Enter in order",
    );
  } finally {
    await browser.close();
  }

  const dialogFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "watch_native_dialog",
    [
      { action: "watchDialog", message: "需要处理浏览器原生弹框" },
      { action: "click", selector: "#open" },
      {
        action: "assertText",
        selector: "#result",
        text: "已确认",
        timeoutMs: 20000,
      },
    ],
  );
  const dialogRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    dialogFlow,
  );
  const dialogPause = await waitIntervention(target, dialogRun.id);
  assert.equal(dialogPause.info.dialog?.type, "alert");
  assert.equal(dialogPause.info.dialog?.message, "需要人工确认");
  await target.request(`/runs/${dialogRun.id}/intervention/actions`, "POST", {
    type: "dialogAccept",
  });
  await target.request(`/runs/${dialogRun.id}/intervention/actions`, "POST", {
    type: "resume",
  });
  const dialogResult = await waitRun(target, dialogRun.id);
  assert.equal(dialogResult.run.status, "passed", dialogResult.run.error);
  console.log("PASS native browser dialog can be accepted before resuming");

  const manualDialogFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "manual_dialog",
    [
      { action: "watchDialog", message: "人工操作时出现浏览器弹框" },
      { action: "pauseForHuman", message: "请点击页面按钮" },
      {
        action: "assertText",
        selector: "#result",
        text: "已确认",
        timeoutMs: 20000,
      },
    ],
  );
  const manualDialogRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    manualDialogFlow,
  );
  await waitIntervention(target, manualDialogRun.id);
  const click = target.request(
    `/runs/${manualDialogRun.id}/intervention/actions`,
    "POST",
    { type: "click", x: 60, y: 18 },
  );
  await waitFor("dialog opened by human click", async () => {
    const state = await target.request(
      `/runs/${manualDialogRun.id}/intervention`,
    );
    return state.info?.dialog ? state : undefined;
  });
  await target.request(
    `/runs/${manualDialogRun.id}/intervention/actions`,
    "POST",
    { type: "dialogAccept" },
  );
  await click;
  await target.request(
    `/runs/${manualDialogRun.id}/intervention/actions`,
    "POST",
    { type: "resume" },
  );
  const manualDialogResult = await waitRun(target, manualDialogRun.id);
  assert.equal(
    manualDialogResult.run.status,
    "passed",
    manualDialogResult.run.error,
  );
  console.log("PASS human click can open a dialog without blocking takeover");

  const waitingFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "watch_during_wait",
    [
      {
        action: "watchElement",
        selector: "#block",
        message: "异步弹框需要处理",
      },
      { action: "click", selector: "#start" },
      { action: "waitFor", selector: "#done", timeoutMs: 20000 },
      { action: "assertText", selector: "#done", text: "已完成" },
    ],
  );
  const waitingRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    waitingFlow,
  );
  await waitIntervention(target, waitingRun.id);
  const during = await target.request(`/runs/${waitingRun.id}`);
  assert.ok(
    during.events.some(
      (event: any) =>
        event.kind === "step" &&
        event.data.status === "start" &&
        event.data.step.action === "waitFor",
    ),
    "监听必须在等待步骤进行时触发",
  );
  await target.request(`/runs/${waitingRun.id}/intervention/actions`, "POST", {
    type: "click",
    x: 50,
    y: 110,
  });
  await target.request(`/runs/${waitingRun.id}/intervention/actions`, "POST", {
    type: "resume",
  });
  const waitingResult = await waitRun(target, waitingRun.id);
  assert.equal(waitingResult.run.status, "passed", waitingResult.run.error);
  console.log(
    "PASS watcher alerts during an in-flight wait and resumes afterward",
  );

  const repeatedFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "repeated_watcher",
    [
      {
        action: "watchElement",
        selector: "#block",
        message: "重复弹框需要处理",
      },
      { action: "click", selector: "#start" },
      { action: "waitFor", selector: "#done", timeoutMs: 20000 },
      { action: "click", selector: "#start" },
      { action: "waitFor", selector: "#block", timeoutMs: 20000 },
      { action: "assertText", selector: "#done", text: "已完成" },
    ],
  );
  const repeatedRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    repeatedFlow,
  );
  for (let index = 0; index < 2; index++) {
    await waitIntervention(target, repeatedRun.id);
    await target.request(
      `/runs/${repeatedRun.id}/intervention/actions`,
      "POST",
      { type: "click", x: 50, y: 110 },
    );
    await target.request(
      `/runs/${repeatedRun.id}/intervention/actions`,
      "POST",
      { type: "resume" },
    );
  }
  const repeatedResult = await waitRun(target, repeatedRun.id);
  assert.equal(repeatedResult.run.status, "passed", repeatedResult.run.error);
  assert.equal(
    repeatedResult.events.filter(
      (event: any) =>
        event.kind === "intervention" && event.data.status === "waiting",
    ).length,
    2,
    "同一监听应处理两次独立出现的弹框",
  );
  console.log("PASS one watcher handles a recurring element twice");

  const clearedFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "clear_watcher",
    [
      { action: "watchElement", selector: "#block", message: "不应触发" },
      { action: "clearWatchers" },
      { action: "click", selector: "#start" },
      { action: "assertVisible", selector: "#block", timeoutMs: 10000 },
    ],
  );
  const clearedRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    clearedFlow,
  );
  const clearedResult = await waitRun(target, clearedRun.id);
  assert.equal(clearedResult.run.status, "passed", clearedResult.run.error);
  assert.ok(
    !clearedResult.events.some((event: any) => event.kind === "intervention"),
    "已清除的监听不应暂停执行",
  );
  console.log("PASS cleared watchers do not interrupt later steps");

  const responseWaitFlow = await makeFlow(
    target,
    project.id,
    fixtureEnvironment.id,
    "wait_response",
    [
      { action: "click", selector: "#network" },
      { action: "waitForResponse", url: "/fixture-response", timeoutMs: 10000 },
      { action: "assertText", selector: "#result", text: "尚未确认" },
    ],
  );
  const responseWaitRun = await start(
    target,
    project.id,
    fixtureEnvironment.id,
    responseWaitFlow,
  );
  const responseWaitResult = await waitRun(target, responseWaitRun.id);
  assert.equal(
    responseWaitResult.run.status,
    "passed",
    responseWaitResult.run.error,
  );
  assert.ok(
    !responseWaitResult.events.some(
      (event: any) => event.kind === "intervention",
    ),
    "普通响应等待不应要求人工接管",
  );
  console.log(
    "PASS blocking response wait continues without human intervention",
  );
} finally {
  fixtureServer.close();
}

const suite = await target.request(`/projects/${project.id}/suites`, "POST", {
  environmentId: environment.id,
  name: "人工接管阻塞后续流程",
  flowIds: [modalFlow.flow.id, responseFlow.flow.id],
});
const batch = await target.request(
  `/projects/${project.id}/suites/${suite.id}/runs`,
  "POST",
);
const suiteItem = await waitFor("suite first item", async () => {
  const report = await target.request(`/suite-runs/${batch.id}`);
  return report.items[0].status === "running" ? report.items[0] : undefined;
});
await waitIntervention(target, suiteItem.id);
let report = await target.request(`/suite-runs/${batch.id}`);
assert.equal(report.run.status, "running");
assert.equal(
  report.items[1].status,
  "queued",
  "人工接管期间测试组不应运行下一项",
);
await target.request(`/suite-runs/${batch.id}/cancel`, "POST");
report = await waitFor("cancelled suite", async () => {
  const current = await target.request(`/suite-runs/${batch.id}`);
  return current.run.status === "cancelled" &&
    current.items.every((item: any) => item.events_complete)
    ? current
    : undefined;
});
assert.equal(report.items[0].status, "cancelled");
assert.equal(report.items[1].started_at, null);
console.log(
  "PASS suite remains blocked during intervention and cancels cleanly",
);
await writeFile(
  ".data/self-test-intervention-result.json",
  JSON.stringify(
    {
      projectId: project.id,
      modalRunId: modalRun.id,
      outerRunId: outerRun.id,
      responseRunId: responseRun.id,
      keyboardRunId,
      suiteRunId: batch.id,
    },
    null,
    2,
  ),
);
