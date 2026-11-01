import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "../src/server/config.js";
import type { Step } from "../src/testing/spec.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
const ownerFile =
  process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json";
const { owner } = JSON.parse(await readFile(ownerFile, "utf8"));
const stamp = Date.now().toString(36);
assert.notEqual(controllerUrl, targetUrl, "工作台和被测实例必须是不同实例");

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

const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
assert.equal((await target.request("/health")).database, true);
const targetUser = {
  name: "测试组自举账号",
  email: `suite-selftest-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
await target.request("/auth/register", "POST", targetUser);
const targetProject = await target.request("/projects", "POST", {
  name: `测试组自举目标 ${stamp}`,
  description: "独立数据库中的测试组端到端验收数据",
});
const targetEnvironment = await target.request(
  `/projects/${targetProject.id}/environments`,
  "POST",
  { name: "被测平台", baseUrl: targetUrl, variables: {} },
);

const flowNames = ["第一项通过", "第二项故意失败", "第三项通过"];
const categories = ["health", "regression", "feature"];
const initialCategories = ["full", "one_off", "feature"];
const flowIds: string[] = [];
for (let index = 0; index < flowNames.length; index++) {
  const testCase = await target.request(
    `/projects/${targetProject.id}/cases`,
    "POST",
    { title: flowNames[index], instructions: "验证被测平台的登录页" },
  );
  const node = await target.request(
    `/projects/${targetProject.id}/nodes`,
    "POST",
    {
      environmentId: targetEnvironment.id,
      key: `suite_check_${index}`,
      name: flowNames[index],
      description: "使用真实浏览器验证登录页",
      spec: {
        inputs: [],
        steps: [
          {
            action: "assertText",
            selector: ".auth-form h2",
            text: index === 1 ? "故意不存在的测试文本" : "登录工作台",
            timeoutMs: index === 1 ? 1000 : 10000,
          },
        ],
      },
    },
  );
  const flow = await target.request(
    `/projects/${targetProject.id}/flows`,
    "POST",
    {
      environmentId: targetEnvironment.id,
      caseId: testCase.id,
      name: flowNames[index],
      category: initialCategories[index],
      steps: [{ revisionId: node.revisionId, params: {} }],
    },
  );
  assert.equal(flow.category, initialCategories[index], "创建时未保存流程分类");
  flowIds.push(flow.id);
  await target.request(
    `/projects/${targetProject.id}/flows/${flow.id}/category`,
    "PATCH",
    { category: categories[index] },
  );
}
const flowList = await target.request(
  `/projects/${targetProject.id}/resources/flows?environmentId=${targetEnvironment.id}`,
);
for (const [index, flowId] of flowIds.entries())
  assert.equal(
    flowList.items.find((flow: any) => flow.id === flowId)?.category,
    categories[index],
    `流程 ${index + 1} 分类未保存`,
  );
console.log("PASS flow categories saved and read back");
const clone = await target.request(
  `/projects/${targetProject.id}/environments/${targetEnvironment.id}/clone`,
  "POST",
  { name: "测试组隔离环境", baseUrl: targetUrl },
);
const clonedFlows = await target.request(
  `/projects/${targetProject.id}/resources/flows?environmentId=${clone.id}`,
);
for (const [index, name] of flowNames.entries())
  assert.equal(
    clonedFlows.items.find((flow: any) => flow.name === name)?.category,
    categories[index],
    `复制环境时丢失流程 ${index + 1} 的分类`,
  );
console.log("PASS copied flows retain categories in the isolated environment");

const controllerProject = await controller.request("/projects", "POST", {
  name: `测试组自举工作台 ${stamp}`,
  description: "通过本平台验证测试组管理、顺序执行与汇总",
});
const controllerEnvironment = await controller.request(
  `/projects/${controllerProject.id}/environments`,
  "POST",
  {
    name: "隔离的被测 LoopLab",
    baseUrl: targetUrl,
    variables: {},
    secrets: { username: targetUser.email, password: targetUser.password },
  },
);
const controllerCase = await controller.request(
  `/projects/${controllerProject.id}/cases`,
  "POST",
  {
    title: "测试组管理、顺序执行和汇总",
    instructions: "通过目标 UI 创建测试组并验证失败后继续执行",
  },
);
const suiteName = `顺序与汇总验收 ${stamp}`;
const nodes: Array<{ key: string; name: string; steps: Step[] }> = [
  {
    key: "login_target",
    name: "登录目标工作台",
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
      {
        action: "assertVisible",
        selector: 'h2:has-text("项目管理")',
        timeoutMs: 20000,
      },
    ],
  },
  {
    key: "manage_suite",
    name: "创建并执行测试组",
    steps: [
      {
        action: "navigate",
        url: `/projects/${targetProject.id}/suites?env=${targetEnvironment.id}`,
      },
      { action: "click", selector: 'button:has-text("创建测试组")' },
      {
        action: "fill",
        selector: '[role="dialog"] input#name',
        value: suiteName,
      },
      {
        action: "fill",
        selector: '[role="dialog"] textarea#description',
        value: "按顺序运行并验证整体结果",
      },
      {
        action: "click",
        selector: '[role="dialog"] button:has-text("添加流程")',
      },
      { action: "click", selector: 'input[aria-label="流程 1"]' },
      {
        action: "click",
        selector:
          '.ant-select-item-option-content:visible:has-text("第一项通过") >> nth=-1',
      },
      {
        action: "click",
        selector: '[role="dialog"] button:has-text("添加流程")',
      },
      { action: "click", selector: 'input[aria-label="流程 2"]' },
      {
        action: "click",
        selector:
          '.ant-select-item-option-content:visible:has-text("第三项通过") >> nth=-1',
      },
      {
        action: "click",
        selector: '[role="dialog"] button:has-text("添加流程")',
      },
      { action: "click", selector: 'input[aria-label="流程 3"]' },
      {
        action: "click",
        selector:
          '.ant-select-item-option-content:visible:has-text("第二项故意失败") >> nth=-1',
      },
      {
        action: "click",
        selector: ':nth-match(button[aria-label="上移流程"], 3)',
      },
      { action: "click", selector: '[role="dialog"] button:has-text("保存")' },
      {
        action: "assertVisible",
        selector: `tr:has-text("${suiteName}")`,
        timeoutMs: 20000,
      },
      {
        action: "click",
        selector: `tr:has-text("${suiteName}") button:has-text("运行测试组")`,
      },
      {
        action: "assertVisible",
        selector: `h2:has-text("测试组报告 · ${suiteName}")`,
        timeoutMs: 20000,
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第三项通过") td:nth-child(4)',
        text: "通过",
        timeoutMs: 120000,
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第一项通过") td:nth-child(1)',
        text: "1",
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第一项通过") td:nth-child(4)',
        text: "通过",
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第二项故意失败") td:nth-child(1)',
        text: "2",
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第二项故意失败") td:nth-child(4)',
        text: "失败",
      },
      {
        action: "assertText",
        selector: 'tr:has-text("第三项通过") td:nth-child(1)',
        text: "3",
      },
      {
        action: "assertText",
        selector:
          '.ant-descriptions-item:has(.ant-descriptions-item-label:text-is("通过")) .ant-descriptions-item-content',
        text: "2",
      },
      {
        action: "assertText",
        selector:
          '.ant-descriptions-item:has(.ant-descriptions-item-label:text-is("失败")) .ant-descriptions-item-content',
        text: "1",
      },
      { action: "screenshot", name: "suite-report" },
    ],
  },
];

const revisions: Array<{ revisionId: string; params: Record<string, string> }> =
  [];
for (const node of nodes) {
  const saved = await controller.request(
    `/projects/${controllerProject.id}/nodes`,
    "POST",
    {
      environmentId: controllerEnvironment.id,
      key: node.key,
      name: node.name,
      description: "使用浏览器操作独立目标实例",
      spec: { inputs: [], steps: node.steps },
    },
  );
  revisions.push({ revisionId: saved.revisionId, params: {} });
}
const controllerFlow = await controller.request(
  `/projects/${controllerProject.id}/flows`,
  "POST",
  {
    environmentId: controllerEnvironment.id,
    caseId: controllerCase.id,
    name: "测试组自举验收",
    steps: revisions,
  },
);
const outerRun = await controller.request(
  `/projects/${controllerProject.id}/runs`,
  "POST",
  {
    environmentId: controllerEnvironment.id,
    caseId: controllerCase.id,
    flowId: controllerFlow.id,
    mode: "execute",
  },
);
console.log(`Self-test browser run: ${outerRun.id}`);
let result: any;
const start = Date.now();
while (Date.now() - start < config.runTimeoutMs + 30_000) {
  result = await controller.request(`/runs/${outerRun.id}`);
  if (result.run.events_complete) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
assert.ok(result?.run.events_complete, "外层浏览器测试超时");
assert.equal(result.run.status, "passed", result.run.error);
assert.ok(result.artifacts.length, "缺少测试组报告截图");

const suites = await target.request(
  `/projects/${targetProject.id}/suites?environmentId=${targetEnvironment.id}`,
);
const suite = suites.items.find((item: any) => item.name === suiteName);
assert.ok(suite, "UI 未创建测试组");
assert.deepEqual(suite.flow_ids, flowIds, "测试组中的流程顺序不正确");
assert.deepEqual(
  (
    await target.request(
      `/projects/${targetProject.id}/suites?environmentId=${clone.id}`,
    )
  ).items,
  [],
  "测试组不应泄漏到另一个环境",
);
const clonedSuiteEnvironment = await target.request(
  `/projects/${targetProject.id}/environments/${targetEnvironment.id}/clone`,
  "POST",
  { name: "复制测试组后的环境", baseUrl: targetUrl },
);
const clonedSuites = await target.request(
  `/projects/${targetProject.id}/suites?environmentId=${clonedSuiteEnvironment.id}`,
);
const clonedSuite = clonedSuites.items.find(
  (item: any) => item.name === suiteName,
);
assert.ok(clonedSuite, "复制环境后缺少测试组");
assert.deepEqual(
  clonedSuite.flows.map((flow: any) => flow.name),
  flowNames,
  "复制后的测试组流程顺序不正确",
);
assert.ok(
  clonedSuite.flow_ids.every((id: string) => !flowIds.includes(id)),
  "复制后的测试组必须引用新环境中的流程",
);
const copiedSuiteFlows = await target.request(
  `/projects/${targetProject.id}/resources/flows?environmentId=${clonedSuiteEnvironment.id}`,
);
assert.deepEqual(
  clonedSuite.flow_ids,
  flowNames.map(
    (name) =>
      copiedSuiteFlows.items.find((flow: any) => flow.name === name)?.id,
  ),
  "测试组没有正确映射新环境中的流程",
);
assert.deepEqual(
  (
    await target.request(
      `/projects/${targetProject.id}/suite-runs?environmentId=${clonedSuiteEnvironment.id}`,
    )
  ).items,
  [],
  "复制环境时不应复制历史批次",
);
const runs = await target.request(
  `/projects/${targetProject.id}/suite-runs?environmentId=${targetEnvironment.id}`,
);
const suiteRun = runs.items.find((item: any) => item.suite_id === suite.id);
assert.ok(suiteRun, "UI 未启动测试组");
const report = await target.request(`/suite-runs/${suiteRun.id}`);
assert.equal(report.run.status, "failed");
assert.equal(Number(report.run.total_count), 3);
assert.equal(Number(report.run.passed_count), 2);
assert.equal(Number(report.run.failed_count), 1);
assert.deepEqual(
  report.items.map((item: any) => item.flow_id),
  flowIds,
);
assert.deepEqual(
  report.items.map((item: any) => item.status),
  ["passed", "failed", "passed"],
);
for (let index = 1; index < report.items.length; index++) {
  const previous = report.items[index - 1];
  const current = report.items[index];
  assert.ok(previous.finished_at && current.started_at, "子流程缺少时间记录");
  assert.ok(
    new Date(previous.finished_at).getTime() <=
      new Date(current.started_at).getTime(),
    `子流程 ${index + 1} 在上一项结束前开始`,
  );
}
await target.request(
  `/projects/${targetProject.id}/suites/${suite.id}`,
  "PUT",
  {
    name: suiteName,
    description: "编辑测试组后历史批次保持原始顺序",
    flowIds: [...flowIds].reverse(),
  },
);
const historical = await target.request(`/suite-runs/${suiteRun.id}`);
assert.deepEqual(
  historical.items.map((item: any) => item.flow_id),
  flowIds,
  "编辑测试组不应改变既有运行记录",
);
await mkdir(".data", { recursive: true });
await writeFile(
  ".data/self-test-suites-result.json",
  JSON.stringify(
    {
      controllerProjectId: controllerProject.id,
      targetProjectId: targetProject.id,
      suiteId: suite.id,
      suiteRunId: suiteRun.id,
      outerRunId: outerRun.id,
      statuses: report.items.map((item: any) => item.status),
    },
    null,
    2,
  ),
);
console.log(
  "PASS UI created and ran the suite; failures did not stop later flows",
);
console.log(
  "PASS ordered [passed, failed, passed], aggregate and report screenshot",
);
