import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
const stamp = Date.now().toString(36);
let cookie = "";
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${targetUrl}/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const data: any = await response.json();
  assert.equal(
    response.status,
    200,
    `${method} ${path}: ${data.error || response.status}`,
  );
  return data;
}

assert.equal((await request("/health")).database, true);
await request("/auth/register", "POST", {
  name: "测试组取消验收账号",
  email: `suite-cancel-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
});
const project = await request("/projects", "POST", {
  name: `测试组取消验收 ${stamp}`,
  description: "独立实例中的真实浏览器取消测试",
});
const environment = await request(
  `/projects/${project.id}/environments`,
  "POST",
  {
    name: "独立被测实例",
    baseUrl: targetUrl,
    variables: {},
  },
);
const flowIds: string[] = [];
for (let index = 0; index < 3; index++) {
  const testCase = await request(`/projects/${project.id}/cases`, "POST", {
    title: index ? `取消后不执行 ${index}` : "等待取消",
    instructions: "验证测试组取消和队列行为",
  });
  const node = await request(`/projects/${project.id}/nodes`, "POST", {
    environmentId: environment.id,
    key: `cancel_check_${index}`,
    name: testCase.title,
    spec: {
      inputs: [],
      steps: [
        {
          action: "assertText",
          selector: ".auth-form h2",
          text: index ? "登录工作台" : "永远不会出现的取消验收文本",
          timeoutMs: index ? 10000 : 120000,
        },
      ],
    },
  });
  const flow = await request(`/projects/${project.id}/flows`, "POST", {
    environmentId: environment.id,
    caseId: testCase.id,
    name: testCase.title,
    steps: [{ revisionId: node.revisionId, params: {} }],
  });
  flowIds.push(flow.id);
}
const suite = await request(`/projects/${project.id}/suites`, "POST", {
  environmentId: environment.id,
  name: "取消正在运行的测试组",
  flowIds,
});
const batch = await request(
  `/projects/${project.id}/suites/${suite.id}/runs`,
  "POST",
);
let report: any;
const waitingUntil = Date.now() + 60000;
while (Date.now() < waitingUntil) {
  report = await request(`/suite-runs/${batch.id}`);
  if (report.items[0].status === "running") {
    const detail = await request(`/runs/${report.items[0].id}`);
    if (
      detail.events.some(
        (event: any) =>
          event.kind === "step" &&
          event.data.status === "start" &&
          event.data.step.action === "assertText",
      )
    )
      break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(Date.now() < waitingUntil, "第一个流程未进入真实浏览器等待步骤");
assert.deepEqual(
  report.items.map((item: any) => item.status),
  ["running", "queued", "queued"],
);
await request(`/suite-runs/${batch.id}/cancel`, "POST");

const cancelUntil = Date.now() + 30000;
while (Date.now() < cancelUntil) {
  report = await request(`/suite-runs/${batch.id}`);
  if (
    report.run.status === "cancelled" &&
    report.items.every((item: any) => item.events_complete)
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(report.run.status, "cancelled", "测试组未进入取消状态");
assert.ok(
  report.items.every((item: any) => item.events_complete),
  "取消后的运行未完成清理",
);
assert.equal(report.run.cancelled_count, 3);
assert.deepEqual(
  report.items.map((item: any) => item.status),
  ["cancelled", "cancelled", "cancelled"],
);
assert.ok(report.items[0].started_at, "首项未实际开始");
for (const item of report.items.slice(1)) {
  assert.equal(item.started_at, null, "取消后的后续项不应启动");
  assert.match(item.summary, /未执行/, "未启动项应显示未执行");
}
await new Promise((resolve) => setTimeout(resolve, 5000));
const after = await request(`/suite-runs/${batch.id}`);
assert.deepEqual(
  after.items.map((item: any) => item.status),
  ["cancelled", "cancelled", "cancelled"],
);
assert.ok(
  after.items.slice(1).every((item: any) => !item.started_at),
  "取消后仍调度了后续项",
);
await mkdir(".data", { recursive: true });
await writeFile(
  ".data/self-test-suites-cancel-result.json",
  JSON.stringify(
    { projectId: project.id, suiteId: suite.id, suiteRunId: batch.id },
    null,
    2,
  ),
);
console.log(
  "PASS cancelled an active browser run and kept subsequent flows unexecuted",
);
