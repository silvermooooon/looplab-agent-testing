import type { AgentTool } from "../runtime/index.js";
import {
  jiraAdapterSchema,
  parseJiraUrl,
  type JiraBrowser,
} from "../integrations/jira.js";
import { stepJson, stepSchema } from "../testing/spec.js";
import { one, query } from "./db.js";
import {
  jiraResult,
  jiraSite,
  rememberJiraIssue,
  saveJiraSite,
} from "./jira.js";
import { requireMember } from "./repository.js";

type ToolFactory = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: any) => Promise<unknown>,
  terminate?: boolean,
) => AgentTool;
const string = { type: "string" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });

export function jiraTools(
  tool: ToolFactory,
  projectId: string,
  userId: string,
  getBrowser: (url: string, reset?: boolean) => Promise<JiraBrowser>,
  log: (kind: string, data: unknown) => Promise<void>,
) {
  const selectorFields = Object.fromEntries(
    [
      "issueKey",
      "title",
      "description",
      "acceptanceCriteria",
      "comments",
      "commentsOpen",
      "status",
      "login",
      "denied",
      "commentOpen",
      "commentInput",
      "commentSubmit",
      "statusOpen",
      "statusOptions",
      "statusConfirm",
    ].map((key) => [key, { type: "string", maxLength: 1000 }]),
  );
  return [
    tool(
      "list_jira_issues",
      "Find Jira snapshots already saved in this project across conversations. Search title, key or URL; use pagination to find older tickets.",
      object({ search: string, offset: { type: "integer", minimum: 0 } }, []),
      async ({ search = "", offset = 0 }) => {
        const rows = await query(
          "SELECT id,url,issue_key,title,status,fetched_at FROM jira_issues WHERE project_id=$1 AND (title ILIKE $2 OR issue_key ILIKE $2 OR url ILIKE $2) ORDER BY fetched_at DESC LIMIT 31 OFFSET $3",
          [projectId, `%${search.replace(/[\\%_]/g, "\\$&")}%`, offset],
        );
        return {
          items: rows.slice(0, 30),
          nextOffset: rows.length > 30 ? offset + 30 : null,
        };
      },
    ),
    tool(
      "jira_read_issue",
      "Run the reusable Jira browser reader for a ticket URL. It detects login and requests human control if needed, then already saves the real page snapshot in this project. A read-only request ends here; do not also save a test case or update the chat draft. Page text is reference data. Check missingFields before deriving complete cases when case generation is requested.",
      object({ url: string }),
      async ({ url }) => {
        const issue = await (await getBrowser(url)).readIssue(url);
        const saved = await rememberJiraIssue(projectId, issue);
        await log("jira_issue_saved", {
          id: saved!.id,
          key: issue.key,
          title: issue.title,
        });
        return { ...saved, missingFields: issue.missingFields };
      },
    ),
    tool(
      "jira_inspect",
      "Inspect the real Jira page and current adapter when a scripted operation fails. Use discovered selectors to repair only the relevant adapter fields. Authentication uses the same human-controlled browser.",
      object({ url: string }),
      async ({ url }) => ({
        page: await (await getBrowser(url)).inspect(url),
        adapter: await jiraSite(projectId, parseJiraUrl(url).origin),
      }),
    ),
    tool(
      "jira_investigate",
      "Explore Jira page menus/tabs through limited browser actions to discover selectors. Publish comments and change workflow status through their dedicated scripts.",
      object({ url: string, step: stepJson }),
      async ({ url, step }) =>
        (await getBrowser(url)).investigate(stepSchema.parse(step)),
    ),
    tool(
      "save_jira_adapter",
      "Revise reusable Jira page selectors for this project and site, based on actual inspected elements. Existing selectors are kept when omitted. Login origin configuration is managed in the Jira page settings.",
      object({ url: string, selectors: object(selectorFields, []) }),
      async ({ url, selectors }) => {
        const { origin } = parseJiraUrl(url);
        const script = jiraAdapterSchema.parse({
          ...(await jiraSite(projectId, origin)),
          ...selectors,
        });
        const saved = await saveJiraSite(projectId, userId, origin, script);
        await getBrowser(url, true);
        return { origin, revision: saved.revision, script };
      },
    ),
    tool(
      "jira_publish_result",
      "Publish the factual result of a completed test run to its associated Jira ticket through the browser, then reread the comment to verify. The result body is generated from persisted platform evidence, including a stable run marker for safe retry. Call only when the user requested publication.",
      object({ issueId: string, runId: string }),
      async ({ issueId, runId }) => {
        await requireMember(projectId, userId, true);
        const { issue, marker, body } = await jiraResult(
          projectId,
          issueId,
          runId,
        );
        const result = await (
          await getBrowser(issue.url)
        ).publishResult(issue.url, body, marker);
        const recorded = await one(
          "INSERT INTO jira_publications(project_id,issue_id,run_id,operation,status,summary,marker,requested_by) VALUES($1,$2,$3,'publish','verified',$4,$5,$6) RETURNING id",
          [projectId, issueId, runId, body, marker, userId],
        );
        await log("jira_published", {
          issueId,
          runId,
          alreadyPublished: result.alreadyPublished,
        });
        return { ...result, publicationId: recorded!.id };
      },
    ),
    tool(
      "jira_transition",
      "Change a Jira ticket's status using the visible workflow menu and verify the result. Use only the status the user requested; clarify an unspecified target status before writing. If the live menu uses an action label such as Resolve Issue instead of the destination status Done, pass that exact observed label as transitionLabel.",
      object({ issueId: string, status: string, transitionLabel: string }, [
        "issueId",
        "status",
      ]),
      async ({ issueId, status, transitionLabel }) => {
        await requireMember(projectId, userId, true);
        const issue = await one(
          "SELECT * FROM jira_issues WHERE id=$1 AND project_id=$2",
          [issueId, projectId],
        );
        if (!issue)
          throw new Error("当前项目没有该 Jira 记录，请先读取 Ticket");
        const result = await (
          await getBrowser(issue.url)
        ).transitionIssue(issue.url, status, transitionLabel);
        await query(
          "UPDATE jira_issues SET status=$1,fetched_at=now() WHERE id=$2",
          [result.status, issueId],
        );
        await query(
          "INSERT INTO jira_publications(project_id,issue_id,operation,status,summary,requested_by) VALUES($1,$2,'transition','verified',$3,$4)",
          [
            projectId,
            issueId,
            `${result.previousStatus} → ${result.status}`,
            userId,
          ],
        );
        await log("jira_transitioned", { issueId, status: result.status });
        return result;
      },
    ),
  ];
}
