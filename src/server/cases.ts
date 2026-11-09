import type { PoolClient } from "pg";
import { z } from "zod";
import { one, query, transaction } from "./db.js";
import { HttpError, requireMember } from "./repository.js";

export const caseInput = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().min(1).max(20000),
  jiraIssueId: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export async function listTestCases(
  projectId: string,
  {
    search = "",
    jiraIssueId,
    offset = 0,
  }: {
    search?: string;
    jiraIssueId?: string;
    offset?: number;
  } = {},
) {
  const term = search.replace(/[\\%_]/g, "\\$&");
  const rows = await query(
    `SELECT c.*,i.issue_key jira_issue_key,i.title jira_issue_title
     FROM test_cases c LEFT JOIN jira_issues i ON i.id=c.jira_issue_id
     WHERE c.project_id=$1 AND NOT c.is_draft
       AND (c.title ILIKE $2 OR c.instructions ILIKE $2)
       AND ($3::uuid IS NULL OR c.jira_issue_id=$3)
     ORDER BY c.created_at DESC,c.id LIMIT 31 OFFSET $4`,
    [projectId, `%${term}%`, jiraIssueId ?? null, offset],
  );
  return {
    items: rows.slice(0, 30),
    nextOffset: rows.length > 30 ? offset + 30 : null,
  };
}

export async function readTestCase(
  projectId: string,
  id: string,
  version?: number,
) {
  const current = await one(
    "SELECT * FROM test_cases WHERE id=$1 AND project_id=$2",
    [id, projectId],
  );
  if (!current) throw new HttpError(404, "测试用例不存在");
  if (version === undefined || version === current.version)
    return { ...current, current_version: current.version };
  const historical = await one(
    "SELECT title,instructions,jira_issue_id,version FROM test_case_versions WHERE case_id=$1 AND version=$2",
    [id, version],
  );
  if (!historical) throw new HttpError(404, "测试用例版本不存在");
  return { ...current, ...historical, current_version: current.version };
}

export async function readTestCaseVersions(projectId: string, id: string) {
  await readTestCase(projectId, id);
  return query(
    "SELECT * FROM test_case_versions WHERE case_id=$1 ORDER BY version DESC",
    [id],
  );
}

export async function saveTestCase(
  projectId: string,
  userId: string,
  input: z.infer<typeof caseInput> & { id?: string },
) {
  await requireMember(projectId, userId, true);
  return transaction(async (client) => {
    const current = input.id
      ? (
          await client.query(
            "SELECT * FROM test_cases WHERE id=$1 AND project_id=$2 FOR UPDATE",
            [input.id, projectId],
          )
        ).rows[0]
      : undefined;
    if (input.id && !current) throw new HttpError(404, "测试用例不存在");
    if (
      current &&
      input.expectedVersion !== undefined &&
      current.version !== input.expectedVersion
    )
      throw new HttpError(409, "测试用例已更新，请读取最新版本后再保存");
    const jiraIssueId =
      input.jiraIssueId === undefined
        ? (current?.jira_issue_id ?? null)
        : input.jiraIssueId;
    if (
      jiraIssueId &&
      !(
        await client.query(
          "SELECT id FROM jira_issues WHERE id=$1 AND project_id=$2",
          [jiraIssueId, projectId],
        )
      ).rowCount
    )
      throw new HttpError(404, "Jira Ticket 不存在或不属于当前项目");
    if (current) {
      await recordCaseVersion(client, current, null);
      if (
        current.title === input.title &&
        current.instructions === input.instructions &&
        current.jira_issue_id === jiraIssueId &&
        !current.is_draft
      )
        return current;
    }
    const saved = current
      ? (
          await client.query(
            "UPDATE test_cases SET title=$1,instructions=$2,jira_issue_id=$3,version=version+1,is_draft=false WHERE id=$4 RETURNING *",
            [input.title, input.instructions, jiraIssueId, current.id],
          )
        ).rows[0]
      : (
          await client.query(
            "INSERT INTO test_cases(project_id,title,instructions,jira_issue_id) VALUES($1,$2,$3,$4) RETURNING *",
            [projectId, input.title, input.instructions, jiraIssueId],
          )
        ).rows[0];
    await recordCaseVersion(client, saved, userId);
    return saved;
  });
}

function recordCaseVersion(
  client: PoolClient,
  row: any,
  userId: string | null,
) {
  return client.query(
    `INSERT INTO test_case_versions(case_id,version,title,instructions,jira_issue_id,created_by)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(case_id,version) DO NOTHING`,
    [
      row.id,
      row.version,
      row.title,
      row.instructions,
      row.jira_issue_id,
      userId,
    ],
  );
}
