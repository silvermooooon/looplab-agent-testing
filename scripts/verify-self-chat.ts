import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "../src/server/config.js";

const base = `http://127.0.0.1:${config.port}`;
const ownerFile =
  process.env.SELF_TEST_OWNER_FILE || ".data/acceptance-credentials.json";
const { owner } = JSON.parse(await readFile(ownerFile, "utf8"));
const previous = JSON.parse(
  await readFile(".data/self-test-result.json", "utf8"),
);
const { projectId: pid, environmentId: eid } = previous;
const stamp = Date.now().toString(36).toUpperCase();
let cookie = "";
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
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
async function waitRun(id: string) {
  const start = Date.now();
  let previousLabel = "";
  while (Date.now() - start < config.runTimeoutMs + 30_000) {
    const data = await request(`/runs/${id}`);
    const label = `${data.run.status}: ${data.events.at(-1)?.kind || "queued"}`;
    if (label !== previousLabel) {
      console.log(label);
      previousLabel = label;
    }
    if (data.run.events_complete) return data;
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Chat self-test run timed out");
}

function validateRun(run: any, item: { marker: string; rounds: number }) {
  assert.equal(run.run.status, "passed", run.run.error);
  assert.ok(run.run.flow_id, "Agent 没有保存流程");
  const steps = run.events
    .filter(
      (event: any) => event.kind === "step" && event.data.status === "passed",
    )
    .map((event: any) => event.data.step);
  const reloadIndex = steps.findIndex((step: any) => step.action === "reload");
  assert.ok(reloadIndex > 0, "缺少刷新页面验证");
  assert.ok(
    steps.some(
      (step: any) =>
        step.action === "click" && step.selector.includes("新对话"),
    ),
    "每次执行必须从新对话开始",
  );
  assert.ok(
    steps.some(
      (step: any) =>
        step.action === "assertText" &&
        step.text.includes(item.marker) &&
        step.selector.includes("ant-bubble-start"),
    ),
    "没有针对助手气泡断言真实回复",
  );
  assert.ok(
    steps.some(
      (step: any) =>
        step.action === "assertText" &&
        step.text.includes("已回复") &&
        step.selector.includes("ant-bubble-start"),
    ),
    "没有验证助手终态",
  );
  assert.ok(
    steps
      .slice(reloadIndex + 1)
      .some(
        (step: any) =>
          step.action === "assertText" &&
          step.text.includes(item.marker) &&
          step.selector.includes("ant-bubble-start"),
      ),
    "刷新后没有重新验证助手回复",
  );
  assert.ok(
    steps
      .slice(reloadIndex + 1)
      .some(
        (step: any) =>
          step.action === "assertText" &&
          step.text.includes("已回复") &&
          step.selector.includes("ant-bubble-start"),
      ),
    "刷新后没有重新验证助手终态",
  );
  assert.ok(
    steps.some(
      (step: any) =>
        step.action === "assertText" &&
        step.selector.includes("ant-bubble-start") &&
        step.timeoutMs >= 60000,
    ),
    "等待 AI 回复需要使用较长的可配置超时",
  );
  if (item.rounds === 2) {
    assert.ok(
      steps.some(
        (step: any) =>
          step.action === "assertText" &&
          step.text.includes(item.marker) &&
          step.selector.includes("2"),
      ),
      "没有区分第二轮助手回复",
    );
    const messages = steps.filter(
      (step: any) =>
        step.action === "fill" && step.selector.includes("textarea"),
    );
    assert.ok(
      messages.length >= 2 && !messages[1].value.includes(item.marker),
      "第二轮用户消息不能包含需要回忆的代号",
    );
  }
  assert.ok(run.artifacts.length > 0, "没有测试截图");
  return steps;
}

await request("/auth/login", "POST", owner);
if (process.argv.includes("--replay")) {
  const saved = JSON.parse(
    await readFile(".data/self-test-chat-result.json", "utf8"),
  );
  const path = `/projects/${saved.projectId}?environmentId=${saved.environmentId}`;
  const before = await request(path);
  for (const item of saved.results) {
    const original = await request(`/runs/${item.generatedRunId}`);
    const marker =
      item.marker ||
      original.events
        .map((event: any) => event.data?.step)
        .find(
          (step: any) =>
            step?.action === "assertText" && step.text.startsWith("SELFTEST-"),
        )?.text;
    assert.ok(marker, "原流程中没有找到对话验证标记");
    const replay = await request(`/projects/${saved.projectId}/runs`, "POST", {
      environmentId: saved.environmentId,
      caseId: item.caseId,
      flowId: item.flowId,
      mode: "execute",
    });
    const result = await waitRun(replay.id);
    validateRun(result, { marker, rounds: item.rounds });
    item.marker = marker;
    item.replayRunId = replay.id;
    console.log(
      `PASS ${item.title}: replay verified actual AI response and persistence`,
    );
  }
  const after = await request(path);
  for (const item of saved.results) {
    const oldFlow = before.flows.find((flow: any) => flow.id === item.flowId);
    const newFlow = after.flows.find((flow: any) => flow.id === item.flowId);
    assert.deepEqual(newFlow.steps, oldFlow.steps);
  }
  await writeFile(
    ".data/self-test-chat-result.json",
    JSON.stringify(saved, null, 2),
  );
} else {
  const project = await request(`/projects/${pid}?environmentId=${eid}`);
  const background = project.knowledge.find(
    (item: any) => item.title === "LoopLab 自举背景",
  );
  assert.ok(
    background,
    "请先运行一次 npm run verify:self 以准备隔离的被测项目",
  );
  await request(`/projects/${pid}/knowledge/${background.id}`, "PUT", {
    title: background.title,
    content: background.content
      .replace(
        "测试只浏览已有数据",
        "测试允许在目标 Agent 对话中发送普通消息并创建独立测试会话，其他资产只读",
      )
      .replace("或启动嵌套 Agent 任务", "或在目标中生成其他测试流程"),
  });
  const chatBackground = project.knowledge.find(
    (item: any) => item.title === "LoopLab AI 对话自测规则",
  );
  const chatContent = `目标是另一个独立 LoopLab 实例和数据库，拥有独立 worker。此处允许在目标 Agent 对话中发送普通问答，但不要要求目标生成或运行测试。每次探索或重放先在目标页面点击“新对话”创建新会话，避免历史消息影响断言。发送后等待真正的助手回复和该助手气泡的“已回复”终态，不要将用户输入、流式部分文字或失败当作通过。输入框是 textarea[placeholder="描述测试目标，或继续讨论与修改…"]，发送按钮有 aria-label="发送消息"；助手气泡为 .ant-bubble-start，其中 .chat-markdown 是正文，.ant-tag 含终态。用 :nth-match(.ant-bubble-start, 1) 和 :nth-match(.ant-bubble-start, 2) 区分第一、第二轮，不能只检查整个消息列表。AI 任务可能超过 20 秒；等待助手回复和已回复状态时为 assertText 或 waitFor 设置 timeoutMs: 120000。使用 reload 步骤刷新当前会话，并在刷新后再次验证已保存的消息和状态。登录节点优先复用已有节点。`;
  if (chatBackground)
    await request(`/projects/${pid}/knowledge/${chatBackground.id}`, "PUT", {
      title: chatBackground.title,
      content: chatContent,
    });
  else
    await request(`/projects/${pid}/knowledge`, "POST", {
      title: "LoopLab AI 对话自测规则",
      content: chatContent,
    });

  const cases = [
    {
      title: `AI 对话 · 基础回复和刷新恢复 ${stamp}`,
      marker: `SELFTEST-HELLO-${stamp}`,
      rounds: 1,
      instructions: `在目标 LoopLab 中登录并进入预置项目的 Agent 对话，点击“新对话”。发送“请只回复 SELFTEST-HELLO-${stamp}”。在第一个助手气泡正文使用 assertText 验证包含 SELFTEST-HELLO-${stamp}，再断言该气泡的状态为“已回复”；两项使用 timeoutMs: 120000 等待真实模型。使用 reload 刷新当前页面，在同一助手气泡再次断言正文和已回复状态，截图。将登录、新对话、发送、检查、刷新与截图拆成可复用节点，优先复用已有登录节点。不要把用户气泡中的文字作为助手回复。`,
    },
    {
      title: `AI 对话 · 多轮上下文 ${stamp}`,
      marker: `SELFTEST-MEMORY-${stamp}`,
      rounds: 2,
      instructions: `在目标 LoopLab 中登录并进入预置项目的 Agent 对话，点击“新对话”。第一轮发送“请记住代号 SELFTEST-MEMORY-${stamp}，这一轮只回复收到。”；等待第一个助手气泡正文包含“收到”且状态为“已回复”。第二轮仅发送“我刚才让你记住的代号是什么？请只回复代号。”，不要在第二条用户消息中包含代号；在第二个助手气泡正文断言包含 SELFTEST-MEMORY-${stamp}，并断言第二个助手气泡状态为“已回复”。以上针对真实 AI 回复的等待使用 timeoutMs: 120000。使用 reload 刷新后，再次检查两个助手气泡的内容、第二个状态和截图。复用已有登录与通用对话节点；区分第一个与第二个助手气泡，不要把用户文字或上一轮答复误判为第二轮答复。`,
    },
  ];
  const results: any[] = [];
  for (const item of cases) {
    const testCase = await request(`/projects/${pid}/cases`, "POST", {
      title: item.title,
      instructions: item.instructions,
    });
    const session = await request(`/projects/${pid}/chat/sessions`, "POST", {
      environmentId: eid,
      caseId: testCase.id,
      title: item.title,
    });
    const sent = await request(
      `/chat/sessions/${session.id}/messages`,
      "POST",
      {
        text: "请执行此用例的全部要求，先调查真实页面，生成并复用节点，再执行独立浏览器重放。",
        clientId: randomUUID(),
      },
    );
    console.log(`CASE ${item.title}: ${sent.runId}`);
    const generated = await waitRun(sent.runId);
    const steps = validateRun(generated, item);
    const replay = await request(`/projects/${pid}/runs`, "POST", {
      environmentId: eid,
      caseId: testCase.id,
      flowId: generated.run.flow_id,
      mode: "execute",
    });
    const repeated = await waitRun(replay.id);
    validateRun(repeated, item);
    results.push({
      title: item.title,
      caseId: testCase.id,
      chatId: session.id,
      flowId: generated.run.flow_id,
      generatedRunId: sent.runId,
      replayRunId: replay.id,
      rounds: item.rounds,
      marker: item.marker,
      assertionCount: steps.filter((step: any) =>
        step.action.startsWith("assert"),
      ).length,
      artifactCount: generated.artifacts.length,
    });
    console.log(
      `PASS ${item.title}: actual AI reply, persistence and independent replay`,
    );
  }
  const assets = await request(`/projects/${pid}?environmentId=${eid}`);
  const flowRevisions = results.map((result) =>
    assets.flows
      .find((flow: any) => flow.id === result.flowId)
      .steps.map((step: any) => step.revisionId),
  );
  assert.ok(
    flowRevisions[0].some((id: string) => flowRevisions[1].includes(id)),
    "两个用例没有复用节点版本",
  );
  await writeFile(
    ".data/self-test-chat-result.json",
    JSON.stringify({ projectId: pid, environmentId: eid, results }, null, 2),
  );
  console.log("PASS two AI chat cases share reusable node revisions");
}
