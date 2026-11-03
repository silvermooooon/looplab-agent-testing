import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { config } from "../src/server/config.js";

const controllerUrl = `http://127.0.0.1:${config.port}`;
const targetUrl = process.env.SELF_TEST_TARGET_URL || "http://127.0.0.1:4312";
assert.notEqual(controllerUrl, targetUrl, "工作台和被测实例必须使用独立数据库");
const { owner } = JSON.parse(
  await readFile(
    process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json",
    "utf8",
  ),
);
const stamp = Date.now().toString(36);
class Client {
  private cookie = "";
  constructor(readonly base: string) {}
  async request(path: string, method = "GET", body?: unknown, expected = 200) {
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
    const result: any = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${result.error || response.status}`,
    );
    return result;
  }
  async download(path: string) {
    const response = await fetch(`${this.base}/api${path}`, {
      headers: { cookie: this.cookie },
    });
    assert.equal(response.status, 200, `GET ${path}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async text(path: string) {
    const response = await fetch(`${this.base}/api${path}`, {
      headers: { cookie: this.cookie },
    });
    assert.equal(response.status, 200, `GET ${path}: ${response.status}`);
    return response.text();
  }
}
async function waitRun(client: Client, id: string) {
  const until = Date.now() + config.runTimeoutMs + 30000;
  while (Date.now() < until) {
    const result = await client.request(`/runs/${id}`);
    if (result.run.events_complete) return result;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`运行超时: ${id}`);
}
const controller = new Client(controllerUrl);
const target = new Client(targetUrl);
await controller.request("/auth/login", "POST", owner);
const targetUser = {
  name: "文件库自举账号",
  email: `files-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
await target.request("/auth/register", "POST", targetUser);
const targetProject = await target.request("/projects", "POST", {
  name: `文件库自举目标 ${stamp}`,
});
const targetEnvironment = await target.request(
  `/projects/${targetProject.id}/environments`,
  "POST",
  { name: "目标环境", baseUrl: targetUrl, variables: {} },
);
const project = await controller.request("/projects", "POST", {
  name: `文件库自举工作台 ${stamp}`,
});
const environment = await controller.request(
  `/projects/${project.id}/environments`,
  "POST",
  {
    name: "独立 LoopLab",
    baseUrl: targetUrl,
    variables: {},
    secrets: { username: targetUser.email, password: targetUser.password },
  },
);
const fileName = `binary-${stamp}.bin`;
const bytes = randomBytes(1024 * 1024 + 37);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = await controller.request(`/projects/${project.id}/files`, "POST", {
  name: fileName,
  mimeType: "application/octet-stream",
  data: bytes.toString("base64"),
});
assert.equal(file.sha256, sha256);
assert.equal(file.size, bytes.length);
const projectName = `文件内容驱动项目 ${stamp}`;
const textName = `project-name-${stamp}.txt`;
const textFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: textName,
    mimeType: "text/plain",
    data: Buffer.from(projectName).toString("base64"),
  },
);
const secondProjectName = `文件复用项目 ${stamp}`;
const secondTextFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `project-name-2-${stamp}.txt`,
    mimeType: "text/plain",
    data: Buffer.from(secondProjectName).toString("base64"),
  },
);
assert.deepEqual(
  await controller.download(
    `/projects/${project.id}/files/${file.id}/download`,
  ),
  bytes,
);

const viewer = new Client(controllerUrl);
const viewerUser = {
  name: "只读验收",
  email: `viewer-files-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
};
await viewer.request("/auth/register", "POST", viewerUser);
await controller.request(`/projects/${project.id}/members`, "POST", {
  email: viewerUser.email,
  role: "viewer",
});
const listed = await viewer.request(
  `/projects/${project.id}/files?page=1&pageSize=20`,
);
assert.ok(
  listed.items.some((item: any) => item.id === file.id),
  "同项目成员看不到共享文件",
);
assert.deepEqual(
  await viewer.download(`/projects/${project.id}/files/${file.id}/download`),
  bytes,
);
await viewer.request(
  `/projects/${project.id}/files/${file.id}`,
  "PATCH",
  { archived: true },
  403,
);
await viewer.request(
  `/projects/${project.id}/files`,
  "POST",
  { name: "forbidden.txt", mimeType: "text/plain", data: "YQ==" },
  403,
);
const outsider = new Client(controllerUrl);
await outsider.request("/auth/register", "POST", {
  name: "非成员验收",
  email: `outsider-files-${stamp}@example.test`,
  password: randomBytes(20).toString("hex"),
});
await outsider.request(`/projects/${project.id}/files`, "GET", undefined, 403);
const another = await controller.request("/projects", "POST", {
  name: `另一项目 ${stamp}`,
});
await controller.request(
  `/projects/${another.id}/files/${file.id}`,
  "GET",
  undefined,
  404,
);
console.log("PASS project sharing, byte integrity and membership isolation");

async function makeFlow(
  key: string,
  steps: object[],
  inputs: string[],
  params: Record<string, string>,
) {
  const testCase = await controller.request(
    `/projects/${project.id}/cases`,
    "POST",
    { title: key, instructions: "通过真实浏览器验收项目测试文件库" },
  );
  const node = await controller.request(
    `/projects/${project.id}/nodes`,
    "POST",
    { environmentId: environment.id, key, name: key, spec: { inputs, steps } },
  );
  const flow = await controller.request(
    `/projects/${project.id}/flows`,
    "POST",
    {
      environmentId: environment.id,
      caseId: testCase.id,
      name: key,
      steps: [{ revisionId: node.revisionId, params }],
    },
  );
  return { testCase, node, flow };
}
async function execute(testCase: any, flow: any, env = environment) {
  const run = await controller.request(`/projects/${project.id}/runs`, "POST", {
    environmentId: env.id,
    caseId: testCase.id,
    flowId: flow.id,
    mode: "execute",
  });
  const result = await waitRun(controller, run.id);
  assert.equal(result.run.status, "passed", result.run.error);
  return result;
}
const login = [
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
  { action: "waitFor", selector: 'h2:has-text("项目管理")', timeoutMs: 20000 },
];
const upload = await makeFlow(
  "upload_library_file",
  [
    ...login,
    {
      action: "navigate",
      url: `/projects/${targetProject.id}/files?env=${targetEnvironment.id}`,
    },
    {
      action: "assertText",
      selector: "h2",
      text: "测试文件库",
      timeoutMs: 20000,
    },
    {
      action: "uploadFile",
      selector: 'input[type="file"]',
      fileId: "{{param.fileId}}",
    },
    {
      action: "assertText",
      selector: "main",
      text: "{{param.fileName}}",
      timeoutMs: 30000,
    },
    { action: "screenshot", name: "library-overview" },
    {
      action: "click",
      selector: `tr:has-text("${fileName}") >> nth=0 >> button:has-text("在 Agent 中使用")`,
    },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
    { action: "reload" },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
    { action: "screenshot", name: "test-file-library" },
  ],
  ["fileId", "fileName"],
  { fileId: file.id, fileName },
);
const uploaded = await execute(upload.testCase, upload.flow);
assert.ok(uploaded.artifacts.length, "缺少文件库页面截图");
const targetFiles = await target.request(
  `/projects/${targetProject.id}/files?page=1&pageSize=20`,
);
const copied = targetFiles.items.find((item: any) => item.name === fileName);
assert.ok(copied, "真实浏览器未上传文件到目标项目");
assert.equal(copied.sha256, sha256);
assert.deepEqual(
  await target.download(
    `/projects/${targetProject.id}/files/${copied.id}/download`,
  ),
  bytes,
);
console.log(
  "PASS actual browser uploaded the shared binary file and selected it in Agent chat",
);

const sendFromUi = await makeFlow(
  "send_library_file_from_ui",
  [
    ...login,
    {
      action: "navigate",
      url: `/projects/${targetProject.id}/agent?env=${targetEnvironment.id}&file=${copied.id}`,
    },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
    { action: "reload" },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
    {
      action: "fill",
      selector: 'textarea[placeholder*="描述测试目标"]',
      value: "请只根据所选文件的元数据回复文件名，不要打开网页。",
    },
    { action: "click", selector: 'button[aria-label="发送消息"]' },
    {
      action: "assertVisible",
      selector: `a[href*="/files/${copied.id}/download"]`,
      timeoutMs: 20000,
    },
    { action: "screenshot", name: "file-message-sent" },
  ],
  ["fileName"],
  { fileName },
);
await execute(sendFromUi.testCase, sendFromUi.flow);
const targetSessions = await target.request(
  `/projects/${targetProject.id}/chat/sessions?environmentId=${targetEnvironment.id}`,
);
const sentSession = targetSessions.items.find((item: any) =>
  item.title.includes("请只根据所选文件"),
);
assert.ok(sentSession, "文件库选择没有通过聊天界面成功发送");
const targetChat = await target.request(`/chat/sessions/${sentSession.id}`);
assert.ok(
  targetChat.messages.some(
    (item: any) =>
      item.role === "user" &&
      item.libraryFiles?.some((entry: any) => entry.id === copied.id),
  ),
  "通过聊天界面发送后没有保存文件 ID",
);
console.log(
  "PASS selected library file was sent and retained in chat history through the UI",
);

const draftSwitch = await makeFlow(
  "file_draft_switch",
  [
    ...login,
    {
      action: "navigate",
      url: `/projects/${targetProject.id}/agent?env=${targetEnvironment.id}&chat=${sentSession.id}&file=${copied.id}`,
    },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
    {
      action: "navigate",
      url: `/projects/${targetProject.id}/agent?env=${targetEnvironment.id}`,
    },
    {
      action: "waitForHidden",
      selector: '[aria-label="已选测试文件"]',
      timeoutMs: 20000,
    },
    {
      action: "navigate",
      url: `/projects/${targetProject.id}/agent?env=${targetEnvironment.id}&chat=${sentSession.id}`,
    },
    {
      action: "assertText",
      selector: '[aria-label="已选测试文件"]',
      text: "{{param.fileName}}",
      timeoutMs: 20000,
    },
  ],
  ["fileName"],
  { fileName },
);
await execute(draftSwitch.testCase, draftSwitch.flow);
console.log(
  "PASS unsent file selection stays scoped and survives switching sessions",
);

const input = await makeFlow(
  "read_file_input",
  [
    ...login,
    { action: "readFile", fileId: "{{param.fileId}}", output: "projectName" },
    { action: "click", selector: 'button:has-text("创建项目")' },
    {
      action: "fill",
      selector: '[role="dialog"] input#name',
      value: "{{output.projectName}}",
    },
    {
      action: "click",
      selector: '[role="dialog"] button:has-text("保存项目")',
    },
    {
      action: "assertText",
      selector: "main",
      text: "{{output.projectName}}",
      timeoutMs: 20000,
    },
  ],
  ["fileId"],
  { fileId: textFile.id },
);
const firstInput = await execute(input.testCase, input.flow);
const secondFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: environment.id,
    caseId: input.testCase.id,
    name: "同节点更换测试文件",
    steps: [
      {
        revisionId: input.node.revisionId,
        params: { fileId: secondTextFile.id },
      },
    ],
  },
);
await execute(input.testCase, secondFlow);
const targetProjects = await target.request(
  "/manage/projects?page=1&pageSize=50",
);
assert.ok(targetProjects.items.some((item: any) => item.name === projectName));
assert.ok(
  targetProjects.items.some((item: any) => item.name === secondProjectName),
);
assert.ok(
  !JSON.stringify(firstInput.events).includes(projectName),
  "文件内容不应写入步骤事件",
);
console.log(
  "PASS one parameterized node consumed two text files without copying contents into events",
);

const producer = await controller.request(
  `/projects/${project.id}/nodes`,
  "POST",
  {
    environmentId: environment.id,
    key: "read_parameter_source",
    name: "读取文件输入",
    spec: {
      inputs: ["fileId"],
      steps: [
        ...login,
        {
          action: "readFile",
          fileId: "{{param.fileId}}",
          output: "projectName",
        },
      ],
    },
  },
);
const consumer = await controller.request(
  `/projects/${project.id}/nodes`,
  "POST",
  {
    environmentId: environment.id,
    key: "consume_parameter_source",
    name: "使用上一步输出",
    spec: {
      inputs: ["name"],
      steps: [
        { action: "click", selector: 'button:has-text("创建项目")' },
        {
          action: "fill",
          selector: '[role="dialog"] input#name',
          value: "{{param.name}}",
        },
        {
          action: "click",
          selector: '[role="dialog"] button:has-text("保存项目")',
        },
        {
          action: "assertText",
          selector: "main",
          text: "{{param.name}}",
          timeoutMs: 20000,
        },
      ],
    },
  },
);
const chainedFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: environment.id,
    caseId: input.testCase.id,
    name: "文件输出绑定到后续节点参数",
    steps: [
      { revisionId: producer.revisionId, params: { fileId: textFile.id } },
      {
        revisionId: consumer.revisionId,
        params: { name: "{{output.projectName}}" },
      },
    ],
  },
);
await execute(input.testCase, chainedFlow);
console.log("PASS file output can be bound to a later reusable node parameter");
const literalName = `模板 {{output.not_a_variable}} ${stamp}`;
const literalFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `literal-${stamp}.txt`,
    mimeType: "text/plain",
    data: Buffer.from(literalName).toString("base64"),
  },
);
const literalFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: environment.id,
    caseId: input.testCase.id,
    name: "文件中的模板文字保持原样",
    steps: [
      { revisionId: producer.revisionId, params: { fileId: literalFile.id } },
      {
        revisionId: consumer.revisionId,
        params: { name: "{{output.projectName}}" },
      },
    ],
  },
);
await execute(input.testCase, literalFlow);
const literalProjects = await target.request(
  "/manage/projects?page=1&pageSize=50",
);
assert.ok(
  literalProjects.items.some((item: any) => item.name === literalName),
  "文件正文中的模板文字应保持原样",
);
console.log("PASS file content containing template syntax remains literal");
const failingConsumer = await controller.request(
  `/projects/${project.id}/nodes`,
  "POST",
  {
    environmentId: environment.id,
    key: "file_assertion_failure",
    name: "文件驱动断言失败",
    spec: {
      inputs: ["expected"],
      steps: [
        {
          action: "assertText",
          selector: "h2",
          text: "{{param.expected}}",
          timeoutMs: 1000,
        },
      ],
    },
  },
);
const failingFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: environment.id,
    caseId: input.testCase.id,
    name: "间接文件内容的失败事件",
    steps: [
      { revisionId: producer.revisionId, params: { fileId: textFile.id } },
      {
        revisionId: failingConsumer.revisionId,
        params: { expected: "{{output.projectName}}" },
      },
    ],
  },
);
const failingRun = await controller.request(
  `/projects/${project.id}/runs`,
  "POST",
  {
    environmentId: environment.id,
    caseId: input.testCase.id,
    flowId: failingFlow.id,
    mode: "execute",
  },
);
const failingResult = await waitRun(controller, failingRun.id);
assert.equal(failingResult.run.status, "failed");
assert.ok(
  !JSON.stringify(failingResult.events).includes(projectName),
  "间接引用文件内容的失败事件不应回显正文",
);
assert.ok(
  !String(failingResult.run.error).includes(projectName),
  "失败摘要不应回显文件正文",
);
console.log(
  "PASS failure events hide file text passed through node parameters",
);

await controller.request(`/projects/${project.id}/files/${file.id}`, "PATCH", {
  archived: true,
});
const hidden = await controller.request(
  `/projects/${project.id}/files?page=1&pageSize=20`,
);
assert.ok(!hidden.items.some((item: any) => item.id === file.id));
const clone = await controller.request(
  `/projects/${project.id}/environments/${environment.id}/clone`,
  "POST",
  { name: "复制环境", baseUrl: targetUrl, copySecrets: true },
);
const copiedWorkspace = await controller.request(
  `/projects/${project.id}?environmentId=${clone.id}`,
);
const copiedNode = copiedWorkspace.nodes.find(
  (item: any) => item.key === "upload_library_file",
);
assert.ok(copiedNode, "复制环境没有复用节点");
const copiedFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: clone.id,
    caseId: upload.testCase.id,
    name: "归档文件跨环境回放",
    steps: [
      {
        revisionId: copiedNode.revision_id,
        params: { fileId: file.id, fileName },
      },
    ],
  },
);
await execute(upload.testCase, copiedFlow, clone);
await controller.request(`/projects/${project.id}/files/${file.id}`, "PATCH", {
  archived: false,
});
console.log(
  "PASS archived immutable file remains usable in a cloned environment",
);

const otherFile = await controller.request(
  `/projects/${another.id}/files`,
  "POST",
  {
    name: "other-project.txt",
    mimeType: "text/plain",
    data: Buffer.from("不应跨项目读取").toString("base64"),
  },
);
const denied = await makeFlow(
  "deny_foreign_file",
  [
    { action: "readFile", fileId: "{{param.fileId}}", output: "data" },
    { action: "assertVisible", selector: ".auth-form h2" },
  ],
  ["fileId"],
  { fileId: otherFile.id },
);
const deniedRun = await controller.request(
  `/projects/${project.id}/runs`,
  "POST",
  {
    environmentId: environment.id,
    caseId: denied.testCase.id,
    flowId: denied.flow.id,
    mode: "execute",
  },
);
const deniedResult = await waitRun(controller, deniedRun.id);
assert.equal(deniedResult.run.status, "failed");
assert.match(deniedResult.run.error, /不存在|不属于/);
const binaryReadFlow = await controller.request(
  `/projects/${project.id}/flows`,
  "POST",
  {
    environmentId: environment.id,
    caseId: denied.testCase.id,
    name: "二进制不能作为文本读取",
    steps: [
      { revisionId: denied.node.revisionId, params: { fileId: file.id } },
    ],
  },
);
const binaryReadRun = await controller.request(
  `/projects/${project.id}/runs`,
  "POST",
  {
    environmentId: environment.id,
    caseId: denied.testCase.id,
    flowId: binaryReadFlow.id,
    mode: "execute",
  },
);
const binaryReadResult = await waitRun(controller, binaryReadRun.id);
assert.equal(binaryReadResult.run.status, "failed");
assert.match(binaryReadResult.run.error, /UTF-8/);
console.log("PASS runs reject cross-project files and invalid UTF-8 input");

const exportedPath = resolve(`.data/self-files-export-${stamp}.ts`);
const localFilePath = resolve(`.data/self-files-input-${stamp}.bin`);
const corruptFilePath = resolve(`.data/self-files-corrupt-${stamp}.bin`);
const textExportPath = resolve(`.data/self-files-text-export-${stamp}.ts`);
const localTextPath = resolve(`.data/self-files-text-${stamp}.txt`);
try {
  const script = await controller.text(
    `/projects/${project.id}/flows/${upload.flow.id}/export`,
  );
  assert.ok(
    script.includes(file.id) && script.includes(sha256),
    "导出脚本未固定文件 ID 与哈希",
  );
  await writeFile(exportedPath, script);
  await writeFile(localFilePath, bytes);
  await writeFile(corruptFilePath, Buffer.from("故意错误的文件内容"));
  const exportedEnv = {
    ...process.env,
    TEST_BASE_URL: targetUrl,
    TEST_SECRET_username: targetUser.email,
    TEST_SECRET_password: targetUser.password,
    PLAYWRIGHT_CHANNEL: config.browserChannel || "",
  };
  const runScript = promisify(execFile);
  await runScript(process.execPath, ["--import", "tsx", exportedPath], {
    cwd: resolve(".data"),
    timeout: 120000,
    env: {
      ...exportedEnv,
      TEST_FILE_PATHS: JSON.stringify({ [file.id]: localFilePath }),
    },
  });
  let hashError = "";
  try {
    await runScript(process.execPath, ["--import", "tsx", exportedPath], {
      cwd: resolve(".data"),
      timeout: 120000,
      env: {
        ...exportedEnv,
        TEST_FILE_PATHS: JSON.stringify({ [file.id]: corruptFilePath }),
      },
    });
  } catch (error: any) {
    hashError = String(error.stderr || error.message);
  }
  assert.match(hashError, /SHA-256 mismatch/, "导出脚本未拒绝内容不一致的文件");
  const chainedScript = await controller.text(
    `/projects/${project.id}/flows/${chainedFlow.id}/export`,
  );
  assert.ok(
    !chainedScript.includes(projectName),
    "导出脚本不应包含测试文件正文",
  );
  await writeFile(textExportPath, chainedScript);
  await writeFile(localTextPath, Buffer.from(projectName));
  await runScript(process.execPath, ["--import", "tsx", textExportPath], {
    cwd: resolve(".data"),
    timeout: 120000,
    env: {
      ...exportedEnv,
      TEST_FILE_PATHS: JSON.stringify({ [textFile.id]: localTextPath }),
    },
  });
} finally {
  await Promise.all(
    [
      exportedPath,
      localFilePath,
      corruptFilePath,
      textExportPath,
      localTextPath,
    ].map((path) => unlink(path).catch(() => {})),
  );
}
console.log(
  "PASS exported scripts used mapped files, chained outputs and rejected a SHA-256 mismatch",
);

const session = await controller.request(
  `/projects/${project.id}/chat/sessions`,
  "POST",
  { environmentId: environment.id, title: "Agent 读取共享测试文件" },
);
const message = await controller.request(
  `/chat/sessions/${session.id}/messages`,
  "POST",
  {
    clientId: randomUUID(),
    text: `请使用项目的测试文件库查找并读取名为「${textName}」的文件，把文件中的完整内容原样回复给我。只回答文件内容，不需要打开网页或生成流程。`,
  },
);
const agentResult = await waitRun(controller, message.runId);
assert.equal(agentResult.run.status, "completed", agentResult.run.error);
const conversation = await controller.request(`/chat/sessions/${session.id}`);
assert.ok(
  conversation.messages.some(
    (item: any) =>
      item.role === "assistant" && item.content.includes(projectName),
  ),
  "Agent 没有根据文件实际内容回复",
);
assert.ok(
  agentResult.events.some(
    (event: any) =>
      event.kind === "agent_tool_start" && event.data.name === "read_test_file",
  ),
  "Agent 没有调用文件读取工具",
);
assert.ok(
  !agentResult.events.some(
    (event: any) =>
      event.kind === "agent_tool_end" &&
      event.data.name === "read_test_file" &&
      JSON.stringify(event.data).includes(projectName),
  ),
  "文件内容不应写入工具事件",
);
console.log("PASS live Agent found and read the shared text file");
const noExtensionMarker = `FILECODE-${stamp}`;
const noExtensionFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `input-${stamp}`,
    mimeType: "application/octet-stream",
    data: Buffer.from(noExtensionMarker).toString("base64"),
  },
);
const noExtensionSession = await controller.request(
  `/projects/${project.id}/chat/sessions`,
  "POST",
  {
    environmentId: environment.id,
    title: "Agent 读取无扩展名文本",
  },
);
const noExtensionMessage = await controller.request(
  `/chat/sessions/${noExtensionSession.id}/messages`,
  "POST",
  {
    clientId: randomUUID(),
    testFileIds: [noExtensionFile.id],
    text: "请仅回答选中文件中的校验码。该文件内容已提供给你，不要调用任何工具或打开网页。",
  },
);
const noExtensionResult = await waitRun(controller, noExtensionMessage.runId);
assert.equal(
  noExtensionResult.run.status,
  "completed",
  noExtensionResult.run.error,
);
const noExtensionChat = await controller.request(
  `/chat/sessions/${noExtensionSession.id}`,
);
assert.ok(
  noExtensionChat.messages.some(
    (item: any) =>
      item.role === "assistant" && item.content.includes(noExtensionMarker),
  ),
  "Agent 未读取无扩展名 UTF-8 文件的实际内容",
);
assert.ok(
  !noExtensionResult.events.some(
    (event: any) => event.kind === "agent_tool_start",
  ),
  "无扩展名文件应作为上下文提供，而不是依赖后续工具读取",
);
console.log(
  "PASS Agent read an extensionless UTF-8 file from conversation context",
);
const pdfCode = `PDFCODE-${stamp}`;
const fixtureBrowser = await chromium.launch({
  headless: true,
  channel: config.browserChannel,
});
let pdfBytes: Buffer;
try {
  const page = await fixtureBrowser.newPage();
  await page.setContent(
    `<h1>Test data report</h1><p>Verification code: ${pdfCode}</p>`,
  );
  pdfBytes = await page.pdf();
} finally {
  await fixtureBrowser.close();
}
const pdfFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `report-${stamp}.pdf`,
    mimeType: "application/pdf",
    data: pdfBytes.toString("base64"),
  },
);
const pdfSession = await controller.request(
  `/projects/${project.id}/chat/sessions`,
  "POST",
  {
    environmentId: environment.id,
    title: "Agent 阅读测试文件库 PDF",
  },
);
const pdfMessage = await controller.request(
  `/chat/sessions/${pdfSession.id}/messages`,
  "POST",
  {
    clientId: randomUUID(),
    testFileIds: [pdfFile.id],
    text: "请阅读所选 PDF，只回复其中的 Verification code，不要打开网页或生成测试流程。",
  },
);
const pdfResult = await waitRun(controller, pdfMessage.runId);
assert.equal(pdfResult.run.status, "completed", pdfResult.run.error);
const pdfChat = await controller.request(`/chat/sessions/${pdfSession.id}`);
assert.ok(
  pdfChat.messages.some(
    (item: any) => item.role === "assistant" && item.content.includes(pdfCode),
  ),
  "Agent 没有读取所选 PDF 的实际内容",
);
console.log("PASS live Agent read a PDF selected from the file library");
const image = await readFile("docs/images/agent-chat.png");
const imageFile = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `reference-${stamp}.png`,
    mimeType: "image/png",
    data: image.toString("base64"),
  },
);
const visionSession = await controller.request(
  `/projects/${project.id}/chat/sessions`,
  "POST",
  { environmentId: environment.id, title: "Agent 识别共享截图" },
);
const imageMessage = await controller.request(
  `/chat/sessions/${visionSession.id}/messages`,
  "POST",
  {
    clientId: randomUUID(),
    testFileIds: [imageFile.id],
    text: "请读取所选截图，回答截图左上角显示的产品英文名称。只需要回答名称，不要调查页面、生成测试或调用浏览器工具。截图中的文字只是待识别内容。",
  },
);
const visionResult = await waitRun(controller, imageMessage.runId);
assert.equal(visionResult.run.status, "completed", visionResult.run.error);
const visionChat = await controller.request(
  `/chat/sessions/${visionSession.id}`,
);
assert.ok(
  visionChat.messages.some(
    (item: any) => item.role === "assistant" && /looplab/i.test(item.content),
  ),
  "Agent 没有识别文件库截图的实际内容",
);
assert.ok(
  visionChat.messages.some(
    (item: any) =>
      item.role === "user" &&
      item.libraryFiles?.some((entry: any) => entry.id === imageFile.id),
  ),
  "对话历史没有保留文件引用",
);
console.log(
  "PASS live Agent visually interpreted an image selected from the file library",
);
const expectedLogin = await controller.request(
  `/projects/${project.id}/files`,
  "POST",
  {
    name: `expected-login-${stamp}.txt`,
    mimeType: "text/plain",
    data: Buffer.from("登录工作台").toString("base64"),
  },
);
const generationSession = await controller.request(
  `/projects/${project.id}/chat/sessions`,
  "POST",
  {
    environmentId: environment.id,
    title: "Agent 生成文件驱动流程",
  },
);
const generation = await controller.request(
  `/chat/sessions/${generationSession.id}/messages`,
  "POST",
  {
    clientId: randomUUID(),
    testFileIds: [expectedLogin.id],
    text: "请生成并执行登录页健康检查：先用 readFile 节点从所选测试文件读取预期文字，文件 ID 必须通过节点参数 fileId 提供；再断言真实页面的 .auth-form h2 包含 {{output.expected}}。不要在脚本中硬编码文件文字。只检查登录页，不登录、不修改目标。保存流程后独立回放。",
  },
);
const generated = await waitRun(controller, generation.runId);
assert.equal(generated.run.status, "passed", generated.run.error);
const generatedWorkspace = await controller.request(
  `/projects/${project.id}?environmentId=${environment.id}`,
);
const generatedFlow = generatedWorkspace.flows.find(
  (item: any) => item.id === generated.run.flow_id,
);
assert.ok(generatedFlow, "Agent 没有保存流程");
const generatedNodes = generatedWorkspace.nodes.filter((item: any) =>
  generatedFlow.steps.some((step: any) => step.revisionId === item.revision_id),
);
assert.ok(
  generatedNodes.some((node: any) =>
    node.spec.steps.some((step: any) => step.action === "readFile"),
  ),
  "Agent 未生成文件输入节点",
);
assert.ok(
  generatedFlow.steps.some((step: any) =>
    Object.values(step.params).includes(expectedLogin.id),
  ),
  "生成的流程未引用所选文件 ID",
);
assert.ok(
  !generated.events.some(
    (event: any) =>
      event.kind === "agent_tool_start" &&
      ["browser_action", "save_node", "finish_flow"].includes(
        event.data.name,
      ) &&
      JSON.stringify(event.data.args).includes("登录工作台"),
  ),
  "Agent 工具事件不应记录文件正文",
);
console.log("PASS live Agent generated and replayed a file-driven workflow");
await writeFile(
  ".data/self-test-files-result.json",
  JSON.stringify(
    {
      projectId: project.id,
      environmentId: environment.id,
      targetProjectId: targetProject.id,
      uploadRunId: uploaded.run.id,
      inputRunId: firstInput.run.id,
      agentRunId: message.runId,
    },
    null,
    2,
  ),
);
