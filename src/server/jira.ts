import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  defaultJiraAdapter,
  jiraAdapterSchema,
  parseJiraUrl,
  type JiraAdapter,
} from "../integrations/jira.js";
import { one, query, transaction } from "./db.js";
import { HttpError, requireMember } from "./repository.js";

export async function jiraSite(
  projectId: string,
  origin: string,
): Promise<JiraAdapter> {
  const row = await one(
    "SELECT script FROM jira_adapters WHERE project_id=$1 AND origin=$2",
    [projectId, origin],
  );
  return row ? jiraAdapterSchema.parse(row.script) : defaultJiraAdapter;
}

export async function saveJiraSite(
  projectId: string,
  userId: string,
  origin: string,
  script: JiraAdapter,
) {
  await requireMember(projectId, userId, true);
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `jira:${projectId}:${origin}`,
    ]);
    const old = (
      await c.query(
        "SELECT * FROM jira_adapters WHERE project_id=$1 AND origin=$2",
        [projectId, origin],
      )
    ).rows[0];
    if (old && isDeepStrictEqual(old.script, script)) return old;
    const row = (
      await c.query(
        `INSERT INTO jira_adapters(project_id,origin,script) VALUES($1,$2,$3)
      ON CONFLICT(project_id,origin) DO UPDATE SET script=EXCLUDED.script,revision=jira_adapters.revision+1,updated_at=now() RETURNING *`,
        [projectId, origin, JSON.stringify(script)],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO jira_adapter_versions(project_id,origin,revision,script,created_by) VALUES($1,$2,$3,$4,$5)",
      [projectId, origin, row.revision, JSON.stringify(script), userId],
    );
    return row;
  });
}

export async function rememberJiraIssue(
  projectId: string,
  issue: {
    url: string;
    origin: string;
    key: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments: string;
    status: string;
  },
) {
  return one(
    `INSERT INTO jira_issues(project_id,origin,url,issue_key,title,description,acceptance,comments,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(project_id,origin,issue_key) DO UPDATE SET url=EXCLUDED.url,title=EXCLUDED.title,description=EXCLUDED.description,acceptance=EXCLUDED.acceptance,comments=EXCLUDED.comments,status=EXCLUDED.status,fetched_at=now() RETURNING *`,
    [
      projectId,
      issue.origin,
      issue.url,
      issue.key,
      issue.title,
      issue.description,
      issue.acceptanceCriteria,
      issue.comments,
      issue.status,
    ],
  );
}

export async function jiraResult(
  projectId: string,
  issueId: string,
  runId: string,
) {
  const issue = await one(
    "SELECT * FROM jira_issues WHERE id=$1 AND project_id=$2",
    [issueId, projectId],
  );
  if (!issue)
    throw new HttpError(404, "当前项目没有该 Jira 记录，请先读取 Ticket");
  const run = await one("SELECT * FROM runs WHERE id=$1 AND project_id=$2", [
    runId,
    projectId,
  ]);
  if (
    !run ||
    !run.events_complete ||
    !["passed", "failed", "cancelled"].includes(run.status) ||
    !run.snapshot?.flow
  )
    throw new HttpError(400, "请选择已结束的真实测试执行记录");
  const snapshotCase = run.snapshot.testCase;
  if (snapshotCase?.jira_issue_id !== issueId)
    throw new HttpError(400, "该运行使用的用例版本未关联此 Jira Ticket");
  const failures = await query(
    "SELECT data FROM run_events WHERE run_id=$1 AND kind='step' AND data->>'status'='failed' ORDER BY id LIMIT 5",
    [runId],
  );
  const marker = `[LoopLab run ${runId}]`;
  const body = [
    `LoopLab 测试结果 ${marker}`,
    `用例：${snapshotCase.title}（版本 ${run.snapshot.flow.case_version ?? "历史版本"}）`,
    `流程：${run.snapshot.flow.name}`,
    `环境：${run.snapshot.environment.name}`,
    `结果：${run.status === "passed" ? "通过" : run.status === "failed" ? "失败" : "已取消"}`,
    `完成时间：${new Date(run.finished_at).toISOString()}`,
    `汇总：${run.summary}`,
    ...(run.error ? [`错误：${run.error}`] : []),
    ...failures.map(
      (item) =>
        `失败步骤：${item.data.name} / ${item.data.step?.action} / ${item.data.error ?? ""}`,
    ),
  ].join("\n");
  return { issue, run, marker, body: body.slice(0, 16000) };
}

export function jiraRoutes(app: FastifyInstance) {
  app.get("/api/projects/:pid/jira", async (r) => {
    const pid = z
      .string()
      .uuid()
      .parse((r.params as any).pid);
    if (!r.currentUser) throw new HttpError(401, "请先登录");
    await requireMember(pid, r.currentUser.id);
    const issues = await query(
      "SELECT * FROM jira_issues WHERE project_id=$1 ORDER BY fetched_at DESC LIMIT 100",
      [pid],
    );
    const [cases, adapters, publications] = await Promise.all([
      query(
        "SELECT * FROM test_cases WHERE project_id=$1 AND NOT is_draft AND jira_issue_id=ANY($2::uuid[]) ORDER BY created_at DESC",
        [pid, issues.map((i) => i.id)],
      ),
      query("SELECT * FROM jira_adapters WHERE project_id=$1 ORDER BY origin", [
        pid,
      ]),
      query(
        "SELECT * FROM jira_publications WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
        [pid],
      ),
    ]);
    return {
      issues,
      cases,
      adapters,
      publications,
      defaultScript: defaultJiraAdapter,
    };
  });
  app.put("/api/projects/:pid/jira/sites", async (r) => {
    const pid = z
      .string()
      .uuid()
      .parse((r.params as any).pid);
    if (!r.currentUser) throw new HttpError(401, "请先登录");
    await requireMember(pid, r.currentUser.id, true);
    const input = z
      .object({
        origin: z.string().url(),
        allowedOrigins: jiraAdapterSchema.shape.allowedOrigins.optional(),
        script: jiraAdapterSchema,
      })
      .parse(r.body);
    const { origin } = parseJiraUrl(
      new URL("/browse/SETUP-1", input.origin).href,
    );
    return saveJiraSite(pid, r.currentUser.id, origin, {
      ...input.script,
      ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
    });
  });
}
