import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "playwright/test";
import { config } from "../src/server/config.js";
const base = `http://127.0.0.1:${config.port}`;
const credentials = {
  owner: {
    name: "管理验收所有者",
    email: `admin-${Date.now().toString(36)}@looplab.local`,
    password: randomBytes(16).toString("hex"),
  },
};
const browser = await chromium.launch({
  channel: config.browserChannel,
  headless: true,
});
const checks: string[] = [];
const check = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
const suffix = Date.now().toString(36),
  name = `管理验收 ${suffix}`;
const context = await browser.newContext({
    viewport: { width: 1512, height: 1040 },
  }),
  page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
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
try {
  await request("/auth/register", "POST", credentials.owner);
  await context.clearCookies();
  await page.goto(base);
  await page.getByLabel("邮箱", { exact: true }).fill(credentials.owner.email);
  await page
    .getByLabel("密码", { exact: true })
    .fill(credentials.owner.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目管理" })).toBeVisible();
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill(name);
  await page.getByLabel("项目说明").fill("管理、隔离与按需加载验收");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByLabel("搜索项目").fill(name);
  await page.getByLabel("搜索项目").press("Enter");
  await expect(
    page.locator("tbody tr.ant-table-row").filter({ hasText: name }),
  ).toBeVisible();
  const row = page.locator("tbody tr.ant-table-row").filter({ hasText: name });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("项目说明").fill("已经编辑的项目说明");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(row).toContainText("已经编辑的项目说明");
  await row.getByRole("link", { name: "进入项目" }).click();
  await expect(page.getByRole("heading", { name: "环境管理" })).toBeVisible();
  const pid = page.url().split("/projects/")[1]!.split("/")[0]!;
  check(
    "Browser creates and edits project, opens dedicated environment management",
  );
  await page.getByRole("button", { name: "创建环境", exact: true }).click();
  await page.getByLabel("环境名称").fill("开发环境");
  await page.getByLabel("部署地址").fill("invalid");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText("请输入有效 HTTP/HTTPS 地址，凭据请单独填写"),
  ).toBeVisible();
  await page.getByLabel("部署地址").fill(base + "/demo");
  await page.getByRole("button", { name: "添加变量" }).click();
  await page.getByLabel("变量键", { exact: true }).fill("message");
  await page.getByLabel("变量值", { exact: true }).fill("hello");
  await page.getByRole("button", { name: "添加凭据" }).click();
  await page.getByLabel("凭据键", { exact: true }).fill("password");
  await page.getByLabel("凭据值", { exact: true }).fill("acceptance-only");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const eid = new URL(page.url()).searchParams.get("env")!;
  assert.ok(eid);
  await page
    .locator("tbody tr.ant-table-row")
    .filter({ hasText: "开发环境" })
    .getByRole("button", { name: "编辑配置" })
    .click();
  await page.getByLabel("变量值", { exact: true }).fill("changed");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const envs = await request(`/projects/${pid}/resources/environments`);
  assert.deepEqual(envs.items[0].secretKeys, ["password"]);
  assert.equal(envs.items[0].variables.message, "changed");
  assert.ok(!JSON.stringify(envs).includes("acceptance-only"));
  check(
    "URL validation, key-value configuration, encrypted credentials preserved and never returned",
  );
  await page
    .locator("tbody tr.ant-table-row")
    .filter({ hasText: "开发环境" })
    .getByRole("button", { name: "复制环境", exact: true })
    .click();
  await page.getByLabel("环境名称").fill("预发布环境");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const cloneId = new URL(page.url()).searchParams.get("env")!;
  assert.notEqual(cloneId, eid);
  const clone = (
    await request(`/projects/${pid}/resources/environments`)
  ).items.find((x: any) => x.id === cloneId);
  assert.deepEqual(clone.secretKeys, []);
  assert.equal(clone.variables.message, "changed");
  await page.reload();
  await expect(page.getByRole("heading", { name: "环境管理" })).toBeVisible();
  assert.equal(new URL(page.url()).searchParams.get("env"), cloneId);
  check(
    "Environment clone is isolated, credentials opt in, URL survives reload",
  );
  // A realistic volume fixture exercises SQL pagination and avoids loading unrelated document bodies.
  for (let i = 0; i < 45; i++)
    await request(`/projects/${pid}/cases`, "POST", {
      title: `用例 ${String(i).padStart(2, "0")}`,
      instructions: "确认页面可用",
    });
  for (let i = 0; i < 25; i++)
    await request(`/projects/${pid}/knowledge`, "POST", {
      title: `页面知识 ${i}`,
      content: "页面背景资料与交互约定。".repeat(600),
    });
  const first = await request(`/projects/${pid}/resources/cases?page=1`),
    second = await request(`/projects/${pid}/resources/cases?page=2`);
  assert.equal(first.total, 45);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 20);
  assert.ok(
    !first.items.some((a: any) => second.items.some((b: any) => a.id === b.id)),
  );
  assert.equal(
    (
      await request(
        `/projects/${pid}/resources/cases?q=${encodeURIComponent("用例 44")}`,
      )
    ).total,
    1,
  );
  await request(
    `/projects/${pid}/resources/cases?pageSize=1000`,
    "GET",
    undefined,
    400,
  );
  await page.getByRole("link", { name: "测试用例", exact: true }).click();
  await expect(page.locator("tbody tr.ant-table-row")).toHaveCount(20);
  await page.getByTitle("下一页").click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.locator("tbody tr.ant-table-row")).toHaveCount(20);
  await page.getByLabel("搜索测试用例").fill("用例 44");
  await page.getByLabel("搜索测试用例").press("Enter");
  await expect(page.locator("tbody tr.ant-table-row")).toHaveCount(1);
  check(
    "Server-side pagination, search, page-size bounds and route restoration",
  );
  let idleRequests = 0;
  const observe = (r: any) => {
    if (r.url().includes("/api/")) idleRequests++;
  };
  page.on("request", observe);
  await page.waitForTimeout(8500);
  page.off("request", observe);
  assert.equal(idleRequests, 0);
  check(
    "Idle workspace sends zero API requests across two previous polling intervals",
  );
  const legacyBytes = Buffer.byteLength(
    JSON.stringify(await request(`/projects/${pid}?environmentId=${eid}`)),
  );
  const leanBytes =
    Buffer.byteLength(
      JSON.stringify(await request(`/projects/${pid}/workspace`)),
    ) + Buffer.byteLength(JSON.stringify(first));
  assert.ok(leanBytes < legacyBytes / 10);
  const caseId = first.items[0].id;
  const node = await request(`/projects/${pid}/nodes`, "POST", {
    environmentId: eid,
    key: "open_demo",
    name: "打开并检查页面",
    description: "真实浏览器回归",
    spec: {
      inputs: [],
      steps: [
        { action: "navigate", url: "{{baseUrl}}" },
        { action: "assertText", selector: "h1", text: "Agent 对话平台" },
        ...Array.from({ length: 37 }, () => ({
          action: "assertVisible",
          selector: "h1",
        })),
        { action: "screenshot", name: "management-demo" },
      ],
    },
  });
  const flow = await request(`/projects/${pid}/flows`, "POST", {
    environmentId: eid,
    caseId,
    name: "管理回归流程",
    steps: Array.from({ length: 4 }, () => ({
      revisionId: node.revisionId,
      params: {},
    })),
  });
  await page.goto(`${base}/projects/${pid}/nodes?env=${eid}`);
  await page.getByRole("button", { name: "版本历史" }).click();
  await expect(
    page.getByText("打开并检查页面 · 版本历史", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "编辑新版本" }).click();
  await page.getByLabel("步骤定义（JSON）").fill(
    JSON.stringify({
      inputs: [],
      steps: [
        { action: "navigate", url: "{{baseUrl}}" },
        { action: "assertVisible", selector: "h1" },
        { action: "assertText", selector: "h1", text: "Agent 对话平台" },
      ],
    }),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  assert.equal(
    (await request(`/projects/${pid}/resources/nodes?environmentId=${eid}`))
      .items[0].version,
    2,
  );
  await page.goto(`${base}/projects/${pid}/flows?env=${eid}`);
  await page.getByRole("button", { name: "编辑副本" }).click();
  await page.getByLabel("名称", { exact: true }).fill("UI 保存的流程副本");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const copiedFlow = (
    await request(`/projects/${pid}/resources/flows?environmentId=${eid}`)
  ).items[0];
  assert.equal(copiedFlow.name, "UI 保存的流程副本");
  assert.equal(copiedFlow.steps[0].revisionId, node.revisionId);
  await page.getByRole("link", { name: "知识库", exact: true }).click();
  await page.getByRole("button", { name: "添加知识" }).click();
  await page.getByLabel("标题", { exact: true }).fill("UI 编辑的背景知识");
  await page.getByLabel("知识内容").fill("保留历史节点版本，流程固定引用。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByText("UI 编辑的背景知识", { exact: true }),
  ).toBeVisible();
  check(
    "Node version drawer, new version editor, pinned historical flow copy and knowledge form",
  );
  await page.goto(`${base}/projects/${pid}/flows?env=${eid}`);
  await expect(
    page.getByRole("button", { name: "重放", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "重放", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: /执行报告/ })).toBeVisible();
  await expect(page.getByText("通过", { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.locator(".run-images img").first()).toBeVisible();
  const runId = new URL(page.url()).searchParams.get("run")!;
  await page.waitForTimeout(2000);
  let finishedRequests = 0;
  const observeRun = (r: any) => {
    if (r.url().includes("/api/runs/")) finishedRequests++;
  };
  page.on("request", observeRun);
  await page.waitForTimeout(4500);
  page.off("request", observeRun);
  assert.equal(finishedRequests, 0);
  const incremental = await request(`/runs/${runId}?incremental=true`);
  assert.ok(!Object.hasOwn(incremental.run, "snapshot"));
  assert.equal(incremental.events.length, 250);
  assert.equal(incremental.hasMore, true);
  const rest = await request(
    `/runs/${runId}?incremental=true&after=${incremental.nextCursor}`,
  );
  assert.ok(rest.events.length > 0);
  assert.equal(rest.hasMore, false);
  assert.ok(
    !rest.events.some((e: any) =>
      incremental.events.some((old: any) => old.id === e.id),
    ),
  );
  assert.equal(
    (await request(`/runs/${runId}?incremental=true&after=${rest.nextCursor}`))
      .events.length,
    0,
  );
  const asset = await page.locator('script[type="module"]').getAttribute("src");
  const compressed = await context.request.get(base + asset, {
    headers: { "accept-encoding": "br" },
  });
  assert.equal(compressed.headers()["content-encoding"], "br");
  assert.match(compressed.headers()["cache-control"]!, /immutable/);
  assert.equal(
    (await context.request.get(base + "/projects")).headers()["cache-control"],
    "no-cache",
  );
  check(
    "UI replays real browser script, renders screenshot, uses cursor and stops polling when complete",
  );
  await page.screenshot({ path: ".data/admin-run-report.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("aside")).toHaveCSS("width", "0px");
  await page.screenshot({ path: ".data/admin-mobile.png", fullPage: true });
  await page.locator(".ant-layout-sider-zero-width-trigger").click();
  await page.getByRole("link", { name: "环境管理", exact: true }).click();
  await expect(page.locator("aside")).toHaveCSS("width", "0px");
  await expect(page.getByRole("heading", { name: "环境管理" })).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  );
  await page.setViewportSize({ width: 1512, height: 1040 });
  // New viewer and unrelated user, using isolated cookies.
  const viewer = await browser.newContext(),
    outsider = await browser.newContext();
  const vEmail = `viewer-${suffix}@looplab.local`;
  const secret = randomBytes(16).toString("hex");
  await viewer.request.post(base + "/api/auth/register", {
    data: { name: "只读验收", email: vEmail, password: secret },
  });
  await outsider.request.post(base + "/api/auth/register", {
    data: {
      name: "外部验收",
      email: `outsider-${suffix}@looplab.local`,
      password: secret,
    },
  });
  await request(`/projects/${pid}/members`, "POST", {
    email: vEmail,
    role: "viewer",
  });
  assert.equal(
    (
      await viewer.request.post(base + `/api/projects/${pid}/environments`, {
        data: { name: "forbidden", baseUrl: base + "/demo" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await outsider.request.get(base + `/api/projects/${pid}/resources/cases`)
    ).status(),
    403,
  );
  assert.equal(
    (
      await viewer.request.post(base + `/api/projects/${pid}/archive`, {
        data: { archived: true },
      })
    ).status(),
    403,
  );
  const vp = await viewer.newPage();
  await vp.goto(`${base}/projects/${pid}/environments?env=${eid}`);
  await expect(
    vp.getByRole("button", { name: "创建环境", exact: true }),
  ).toBeDisabled();
  await expect(
    vp.getByText("你拥有只读权限。", { exact: false }),
  ).toBeVisible();
  await viewer.close();
  await outsider.close();
  check("Multiuser membership enforced by API and readonly UI");
  await request(`/projects/${pid}/environments/${eid}/archive`, "POST", {
    archived: true,
  });
  await request(
    `/projects/${pid}/runs`,
    "POST",
    { environmentId: eid, caseId, mode: "execute", flowId: flow.id },
    409,
  );
  await request(`/projects/${pid}/environments/${eid}/archive`, "POST", {
    archived: false,
  });
  await request(`/projects/${pid}/archive`, "POST", { archived: true });
  await request(
    `/projects/${pid}/cases`,
    "POST",
    { title: "forbidden", instructions: "x" },
    409,
  );
  assert.equal((await request(`/projects/${pid}/resources/cases`)).total, 45);
  await request(`/projects/${pid}/archive`, "POST", { archived: false });
  check(
    "Project and environment archive block new work, retain records and can be restored",
  );
  await page.goto(`${base}/projects/${pid}/environments?env=${eid}`);
  await expect(page.getByRole("heading", { name: "环境管理" })).toBeVisible();
  await page.screenshot({
    path: ".data/admin-environments.png",
    fullPage: true,
  });
  await page.goto(`${base}/projects`);
  await expect(page.getByRole("heading", { name: "项目管理" })).toBeVisible();
  await page.screenshot({ path: ".data/admin-projects.png", fullPage: true });
  assert.deepEqual(errors, []);
  check("Desktop and mobile browser UI: no page errors or horizontal overflow");
  await page
    .locator("tbody tr.ant-table-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByText("已归档", { exact: true }).click();
  await page
    .locator("tbody tr.ant-table-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await page.getByRole("button", { name: "恢复项目", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByText("进行中", { exact: true }).click();
  await expect(
    page.locator("tbody tr.ant-table-row").filter({ hasText: name }),
  ).toBeVisible();
  check("Project archive and restore through confirmation dialogs");
  await request(`/projects/${pid}/archive`, "POST", { archived: true });
  await writeFile(
    ".data/management-result.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        projectId: pid,
        runId,
        checks,
        metrics: {
          legacyBytes,
          leanBytes,
          reduction: 1 - leanBytes / legacyBytes,
          idleRequests,
          finishedRequests,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      legacyBytes,
      leanBytes,
      idleRequests,
      finishedRequests,
    }),
  );
} catch (e) {
  await page.screenshot({ path: ".data/admin-failure.png", fullPage: true });
  console.log("Browser verification failed; screenshot saved locally.");
  throw new Error((e as Error).message);
} finally {
  await browser.close();
}
