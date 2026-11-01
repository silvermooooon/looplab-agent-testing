import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { one, query, transaction } from "./db.js";
import {
  activeEnvironment,
  environment,
  HttpError,
  lockActiveScope,
  requireMember,
} from "./repository.js";
import { cancelRun } from "./worker.js";

const uuid = z.string().uuid();
const category = z.enum(["health", "full", "feature", "one_off", "regression"]);
const suiteInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  flowIds: z.array(uuid).max(100).default([]),
});
const path = (r: FastifyRequest, key: string) =>
  uuid.parse((r.params as Record<string, string>)[key]);
const uid = (r: FastifyRequest) => {
  if (!r.currentUser) throw new HttpError(401, "请先登录");
  return r.currentUser.id;
};

async function checkedFlows(
  c: PoolClient,
  projectId: string,
  environmentId: string,
  flowIds: string[],
) {
  const { rows } = await c.query(
    `SELECT f.id,f.name,f.case_id,c.title AS case_title FROM flows f JOIN test_cases c ON c.id=f.case_id
     WHERE f.project_id=$1 AND f.environment_id=$2 AND f.id=ANY($3::uuid[])`,
    [projectId, environmentId, flowIds],
  );
  const byId = new Map(rows.map((flow) => [flow.id, flow]));
  if (flowIds.some((id) => !byId.has(id)))
    throw new HttpError(400, "测试组包含不属于当前项目或环境的流程");
  return flowIds.map((id) => byId.get(id)!);
}

const suiteRunSelect = `SELECT s.*, counts.*,
  CASE WHEN counts.running_count>0 OR (counts.queued_count=0 AND counts.incomplete_count>0) THEN 'running'
       WHEN counts.queued_count>0 AND counts.finished_count>0 THEN 'running'
       WHEN counts.queued_count>0 THEN 'queued'
       WHEN s.cancel_requested OR counts.cancelled_count>0 THEN 'cancelled'
       WHEN counts.failed_count>0 THEN 'failed' ELSE 'passed' END AS status
  FROM suite_runs s JOIN LATERAL (
    SELECT count(*)::int total_count,
      count(*) FILTER (WHERE status='passed')::int passed_count,
      count(*) FILTER (WHERE status='failed')::int failed_count,
      count(*) FILTER (WHERE status='cancelled')::int cancelled_count,
      count(*) FILTER (WHERE status='queued')::int queued_count,
      count(*) FILTER (WHERE status='running')::int running_count,
      count(*) FILTER (WHERE status NOT IN ('queued','running'))::int finished_count,
      count(*) FILTER (WHERE NOT events_complete)::int incomplete_count,
      min(started_at) started_at,
      CASE WHEN count(*) FILTER (WHERE status IN ('queued','running') OR NOT events_complete)=0 THEN max(finished_at) END finished_at
    FROM runs WHERE suite_run_id=s.id
  ) counts ON true`;

export async function suiteRoutes(app: FastifyInstance) {
  app.patch("/api/projects/:pid/flows/:fid/category", async (r) => {
    const pid = path(r, "pid"),
      fid = path(r, "fid");
    await requireMember(pid, uid(r), true);
    const input = z.object({ category }).parse(r.body);
    const flow = await one(
      "SELECT environment_id FROM flows WHERE id=$1 AND project_id=$2",
      [fid, pid],
    );
    if (!flow) throw new HttpError(404, "流程不存在");
    await activeEnvironment(pid, flow.environment_id);
    return transaction(async (c) => {
      await lockActiveScope(c, pid, flow.environment_id);
      return (
        await c.query(
          "UPDATE flows SET category=$1 WHERE id=$2 AND project_id=$3 RETURNING *",
          [input.category, fid, pid],
        )
      ).rows[0];
    });
  });
  app.get("/api/projects/:pid/suites", async (r) => {
    const pid = path(r, "pid"),
      { environmentId } = z.object({ environmentId: uuid }).parse(r.query);
    await requireMember(pid, uid(r));
    await environment(pid, environmentId);
    const items = await query(
      `SELECT s.*, COALESCE((SELECT json_agg(json_build_object('id',f.id,'name',f.name,'case_title',c.title,'category',f.category) ORDER BY ids.ordinality)
      FROM unnest(s.flow_ids) WITH ORDINALITY ids(id,ordinality) JOIN flows f ON f.id=ids.id JOIN test_cases c ON c.id=f.case_id), '[]'::json) flows
      FROM test_suites s WHERE s.project_id=$1 AND s.environment_id=$2 ORDER BY s.updated_at DESC,s.id`,
      [pid, environmentId],
    );
    return { items };
  });
  app.post("/api/projects/:pid/suites", async (r) => {
    const pid = path(r, "pid"),
      userId = uid(r);
    await requireMember(pid, userId, true);
    const input = suiteInput.extend({ environmentId: uuid }).parse(r.body);
    await activeEnvironment(pid, input.environmentId);
    return transaction(async (c) => {
      await lockActiveScope(c, pid, input.environmentId);
      await checkedFlows(c, pid, input.environmentId, input.flowIds);
      return (
        await c.query(
          `INSERT INTO test_suites(project_id,environment_id,name,description,flow_ids,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            pid,
            input.environmentId,
            input.name,
            input.description,
            input.flowIds,
            userId,
          ],
        )
      ).rows[0];
    });
  });
  app.put("/api/projects/:pid/suites/:sid", async (r) => {
    const pid = path(r, "pid"),
      sid = path(r, "sid");
    await requireMember(pid, uid(r), true);
    const input = suiteInput.parse(r.body);
    const suite = await one(
      "SELECT * FROM test_suites WHERE id=$1 AND project_id=$2",
      [sid, pid],
    );
    if (!suite) throw new HttpError(404, "测试组不存在");
    await activeEnvironment(pid, suite.environment_id);
    return transaction(async (c) => {
      await lockActiveScope(c, pid, suite.environment_id);
      await checkedFlows(c, pid, suite.environment_id, input.flowIds);
      const result = await c.query(
        `UPDATE test_suites SET name=$1,description=$2,flow_ids=$3,updated_at=now()
        WHERE id=$4 AND project_id=$5 RETURNING *`,
        [input.name, input.description, input.flowIds, sid, pid],
      );
      if (!result.rowCount) throw new HttpError(404, "测试组不存在");
      return result.rows[0];
    });
  });
  app.delete("/api/projects/:pid/suites/:sid", async (r) => {
    const pid = path(r, "pid"),
      sid = path(r, "sid");
    await requireMember(pid, uid(r), true);
    const suite = await one(
      "SELECT * FROM test_suites WHERE id=$1 AND project_id=$2",
      [sid, pid],
    );
    if (!suite) throw new HttpError(404, "测试组不存在");
    await activeEnvironment(pid, suite.environment_id);
    await query("DELETE FROM test_suites WHERE id=$1 AND project_id=$2", [
      sid,
      pid,
    ]);
    return { ok: true };
  });
  app.post("/api/projects/:pid/suites/:sid/runs", async (r) => {
    const pid = path(r, "pid"),
      sid = path(r, "sid"),
      userId = uid(r);
    await requireMember(pid, userId, true);
    const suite = await one(
      "SELECT environment_id FROM test_suites WHERE id=$1 AND project_id=$2",
      [sid, pid],
    );
    if (!suite) throw new HttpError(404, "测试组不存在");
    await activeEnvironment(pid, suite.environment_id);
    return transaction(async (c) => {
      await lockActiveScope(c, pid, suite.environment_id);
      const current = (
        await c.query(
          "SELECT * FROM test_suites WHERE id=$1 AND project_id=$2 FOR UPDATE",
          [sid, pid],
        )
      ).rows[0];
      if (!current) throw new HttpError(404, "测试组不存在");
      const flows = await checkedFlows(
        c,
        pid,
        current.environment_id,
        current.flow_ids,
      );
      if (!flows.length) throw new HttpError(400, "请先为测试组添加流程");
      const batch = (
        await c.query(
          `INSERT INTO suite_runs(suite_id,project_id,environment_id,suite_name,requested_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [sid, pid, current.environment_id, current.name, userId],
        )
      ).rows[0];
      for (const [position, flow] of flows.entries()) {
        await c.query(
          `INSERT INTO runs(project_id,environment_id,case_id,mode,flow_id,requested_by,suite_run_id,suite_position,suite_flow_name,suite_case_title)
          VALUES($1,$2,$3,'execute',$4,$5,$6,$7,$8,$9)`,
          [
            pid,
            current.environment_id,
            flow.case_id,
            flow.id,
            userId,
            batch.id,
            position + 1,
            flow.name,
            flow.case_title,
          ],
        );
      }
      return batch;
    });
  });
  app.get("/api/projects/:pid/suite-runs", async (r) => {
    const pid = path(r, "pid"),
      { environmentId } = z.object({ environmentId: uuid }).parse(r.query);
    await requireMember(pid, uid(r));
    await environment(pid, environmentId);
    return {
      items: await query(
        `${suiteRunSelect} WHERE s.project_id=$1 AND s.environment_id=$2 ORDER BY s.created_at DESC,s.id LIMIT 100`,
        [pid, environmentId],
      ),
    };
  });
  app.get("/api/suite-runs/:id", async (r) => {
    const batch = await one(`${suiteRunSelect} WHERE s.id=$1`, [path(r, "id")]);
    if (!batch) throw new HttpError(404, "测试组运行不存在");
    await requireMember(batch.project_id, uid(r));
    const items = await query(
      `SELECT id,suite_position AS position,flow_id,suite_flow_name AS flow_name,suite_case_title AS case_title,
      status,summary,error,started_at,finished_at,events_complete FROM runs WHERE suite_run_id=$1 ORDER BY suite_position`,
      [batch.id],
    );
    return { run: batch, items };
  });
  app.post("/api/suite-runs/:id/cancel", async (r) => {
    const batch = await one("SELECT * FROM suite_runs WHERE id=$1", [
      path(r, "id"),
    ]);
    if (!batch) throw new HttpError(404, "测试组运行不存在");
    await requireMember(batch.project_id, uid(r), true);
    const runningIds = await transaction(async (c) => {
      const active = (
        await c.query(
          "SELECT id FROM runs WHERE suite_run_id=$1 AND status IN ('queued','running') FOR UPDATE",
          [batch.id],
        )
      ).rows;
      if (!active.length) return [];
      await c.query("UPDATE suite_runs SET cancel_requested=true WHERE id=$1", [
        batch.id,
      ]);
      await c.query(
        `UPDATE runs SET cancel_requested=true,
        status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
        events_complete=CASE WHEN status='queued' THEN true ELSE events_complete END,
        finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
        summary=CASE WHEN status='queued' THEN '未执行（测试组已取消）' ELSE summary END
        WHERE suite_run_id=$1 AND status IN ('queued','running')`,
        [batch.id],
      );
      return active.map((row) => row.id as string);
    });
    await Promise.all(runningIds.map(cancelRun));
    return { ok: true };
  });
}
