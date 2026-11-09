import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { config } from "../src/server/config.js";

const evidence = JSON.parse(
  await readFile(
    process.env.SELF_TEST_JIRA_RESULT_FILE ||
      ".data/self-test-jira-result.json",
    "utf8",
  ),
);
const credentials = JSON.parse(
  await readFile(
    process.env.SELF_TEST_JIRA_CREDENTIALS_FILE ||
      ".data/jira-fixture/target-credentials.json",
    "utf8",
  ),
);
const base = evidence.targetUrl as string;
const scope = `/projects/${evidence.projectId}`;
const fixtureUrl = new URL(evidence.issueUrl).origin;
let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const freshCookie = response.headers.get("set-cookie");
  if (freshCookie) cookie = freshCookie.split(";")[0]!;
  const result: any = await response.json();
  assert.equal(
    response.status,
    200,
    `${method} ${path}: ${result.error || response.status}`,
  );
  return result;
}
async function waitRun(id: string, status: string) {
  const deadline = Date.now() + config.runTimeoutMs + 60000;
  while (Date.now() < deadline) {
    const result = await api(`/runs/${id}`);
    if (result.run.events_complete) {
      assert.equal(
        result.run.status,
        status,
        result.run.error || result.run.summary,
      );
      return result;
    }
    const intervention = await api(`/runs/${id}/intervention`);
    if (intervention.active) {
      assert.match(intervention.info.message, /Jira.*登录/);
      for (const action of [
        { type: "type", text: "jira-e2e@example.test" },
        { type: "press", key: "Tab" },
        { type: "type", text: "local-fixture-password" },
        { type: "press", key: "Enter" },
        { type: "resume" },
      ])
        await api(`/runs/${id}/intervention/actions`, "POST", action);
    }
    await setTimeout(900);
  }
  throw new Error(`运行超时：${id}`);
}
async function ask(title: string, text: string) {
  const session = await api(`${scope}/chat/sessions`, "POST", {
    title,
    environmentId: evidence.environmentId,
  });
  const { runId } = await api(`/chat/sessions/${session.id}/messages`, "POST", {
    text,
    clientId: randomUUID(),
  });
  console.log(`${title}: ${runId}`);
  return waitRun(runId, "completed");
}
const control = async () =>
  (await (await fetch(`${fixtureUrl}/control`)).json()) as {
    comments: string[];
    status: string;
  };
await api("/auth/login", "POST", credentials.owner || credentials);
const original = await api(`${scope}/cases/${evidence.caseId}`);
assert.equal(original.version, 2, "本补充验收从主流程保存的用例 v2 开始");
assert.equal(original.jira_issue_id, evidence.issueId);
const changed = await api(`${scope}/cases/${evidence.caseId}`, "PUT", {
  title: original.title,
  instructions: `${original.instructions}\n\n人工更新到 v3：当前版本解除 Jira 关联，已保存流程仍按 v2 验证。`,
  expectedVersion: 2,
  jiraIssueId: null,
});
assert.equal(changed.version, 3);
assert.equal(changed.jira_issue_id, null);
const queued = await api(`${scope}/runs`, "POST", {
  environmentId: evidence.environmentId,
  caseId: evidence.caseId,
  flowId: evidence.flowId,
  mode: "execute",
});
const replay = await waitRun(queued.id, "passed");
assert.equal(replay.run.snapshot.flow.case_version, 2);
assert.equal(replay.run.snapshot.testCase.version, 2);
assert.equal(replay.run.snapshot.testCase.jira_issue_id, evidence.issueId);
assert.equal(replay.run.snapshot.testCase.instructions, original.instructions);
const latest = await api(`${scope}/cases/${evidence.caseId}`);
assert.equal(latest.version, 3);
assert.equal(latest.jira_issue_id, null);
const listed = await api(
  `${scope}/resources/runs?environmentId=${evidence.environmentId}&q=${queued.id}`,
);
assert.equal(
  listed.items[0].jira_issue_id,
  evidence.issueId,
  "运行选择器必须暴露执行快照中的 Jira 关联",
);
console.log(
  "PASS a saved v2 flow replays v2 content and association after the latest case moves to detached v3",
);

const before = await control();
const published = await ask(
  "publish_pinned_version",
  `请把真实运行 ${queued.id} 的测试结果回写到 Jira ${evidence.issueUrl}。该运行固定使用用例 v2，其历史快照仍关联此 Jira；当前用例 v3 解除关联不应改变历史证据。请实际调用 jira_publish_result 并在页面核验。`,
);
assert.ok(
  published.events.some(
    (event: any) =>
      event.kind === "jira_published" && event.data.runId === queued.id,
  ),
);
const after = await control();
assert.equal(after.comments.length, before.comments.length + 1);
assert.ok(after.comments.at(-1)?.includes(`[LoopLab run ${queued.id}]`));
assert.ok(after.comments.at(-1)?.includes("版本 2"));
console.log(
  "PASS Jira publication uses the recorded case version and its association",
);

const invalid = await ask(
  "reject_conversation_result",
  `这是一轮错误输入验收。请实际调用一次 jira_publish_result，参数 issueId 为 ${evidence.issueId}，runId 为 ${evidence.cases_only}。该 ID 是仅整理用例的对话，不是真实测试执行；需要核对服务端明确拒绝。不要创建或运行任何流程，不要改用其他运行，不要调用其他写入工具。收到错误后报告原错误并结束。`,
);
assert.ok(
  invalid.events.some(
    (event: any) =>
      event.kind === "agent_tool_end" &&
      event.data.name === "jira_publish_result" &&
      event.data.isError,
  ),
  "必须真实尝试并验证服务端拒绝",
);
assert.ok(
  !invalid.events.some((event: any) => event.kind === "jira_published"),
);
assert.ok(
  !invalid.events.some(
    (event: any) =>
      event.kind === "agent_tool_start" &&
      ["run_flow", "save_flow", "finish_flow"].includes(event.data.name),
  ),
);
assert.equal((await control()).comments.length, after.comments.length);
console.log(
  "PASS a conversation-only run cannot be presented as a factual test result",
);

const aliasUrl = `${evidence.issueUrl}?view=activity#comments`;
const alias = await ask(
  "reuse_jira_alias",
  `请使用 jira_read_issue 读取 ${aliasUrl}，本轮只更新需求快照，不创建或修改用例、流程，也不执行测试。`,
);
const savedEvent = alias.events.find(
  (event: any) => event.kind === "jira_issue_saved",
);
assert.equal(savedEvent?.data.id, evidence.issueId);
const jira = await api(`${scope}/jira`);
assert.equal(
  jira.issues.filter((issue: any) => issue.issue_key === "DEMO-1").length,
  1,
);
assert.equal((await api(`${scope}/cases/${evidence.caseId}`)).version, 3);
console.log(
  "PASS alternate ticket URLs reuse the same persisted issue without changing cases",
);
await writeFile(
  ".data/self-test-jira-evidence-result.json",
  JSON.stringify(
    {
      projectId: evidence.projectId,
      caseId: evidence.caseId,
      issueId: evidence.issueId,
      originalFlowId: evidence.flowId,
      pinnedRunId: queued.id,
      publishedRunId: published.run.id,
      invalidRunId: invalid.run.id,
      aliasRunId: alias.run.id,
      currentCaseVersion: 3,
      executedCaseVersion: 2,
      status: "passed",
    },
    null,
    2,
  ),
);
