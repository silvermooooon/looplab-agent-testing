import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { one, query, transaction } from "./db.js";
import { HttpError, requireMember, environment } from "./repository.js";
import { decryptSecrets, encryptSecrets } from "./security.js";

const uuid = z.string().uuid();
const paging = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).default(""),
  archived: z.enum(["true", "false"]).default("false"),
  environmentId: uuid.optional(),
});
const uid = (r: FastifyRequest) => {
  if (!r.currentUser) throw new HttpError(401, "请先登录");
  return r.currentUser.id;
};
const path = (r: FastifyRequest, key: string) =>
  uuid.parse((r.params as any)[key]);
const safeEnv = ({ secrets_encrypted, ...env }: any) => ({
  ...env,
  secretKeys: Object.keys(decryptSecrets(secrets_encrypted)),
});
async function pageResult(
  sql: string,
  args: unknown[],
  page: number,
  size: number,
) {
  const [count, items] = await Promise.all([
    one(`SELECT count(*)::int AS total FROM (${sql}) counted`, args),
    query(`${sql} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [
      ...args,
      size,
      (page - 1) * size,
    ]),
  ]);
  return { items, total: count!.total, page, pageSize: size };
}
export async function management(app: FastifyInstance) {
  app.get("/api/manage/projects", async (r) => {
    const p = paging.parse(r.query);
    return pageResult(
      `SELECT p.*,m.role,
      (SELECT count(*)::int FROM environments e WHERE e.project_id=p.id AND e.archived_at IS NULL) environment_count,
      (SELECT count(*)::int FROM members t WHERE t.project_id=p.id) member_count
      FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=$1
      AND (p.archived_at IS NOT NULL)=$2 AND (p.name ILIKE $3 OR p.description ILIKE $3) ORDER BY p.created_at DESC,p.id`,
      [uid(r), p.archived === "true", `%${p.q}%`],
      p.page,
      p.pageSize,
    );
  });
  app.put("/api/projects/:pid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true, true);
    const b = z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(4000).default(""),
      })
      .parse(r.body);
    return one(
      "UPDATE projects SET name=$2,description=$3 WHERE id=$1 RETURNING *",
      [pid, b.name, b.description],
    );
  });
  app.post("/api/projects/:pid/archive", async (r) => {
    const pid = path(r, "pid");
    const role = await requireMember(pid, uid(r));
    if (role !== "owner")
      throw new HttpError(403, "只有所有者可以归档或恢复项目");
    const b = z.object({ archived: z.boolean() }).parse(r.body);
    return transaction(async (c) => {
      await c.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [pid]);
      if (
        b.archived &&
        (
          await c.query(
            "SELECT 1 FROM runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
            [pid],
          )
        ).rowCount
      )
        throw new HttpError(409, "请等待或取消运行中的任务后再归档");
      await c.query(
        "UPDATE projects SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1",
        [pid, b.archived],
      );
      return { ok: true };
    });
  });
  app.get("/api/projects/:pid/workspace", async (r) => {
    const pid = path(r, "pid");
    const role = await requireMember(pid, uid(r));
    const [project, envs] = await Promise.all([
      one("SELECT * FROM projects WHERE id=$1", [pid]),
      query(
        "SELECT id,name,base_url,archived_at FROM environments WHERE project_id=$1 ORDER BY created_at",
        [pid],
      ),
    ]);
    return { project, role, environments: envs };
  });
  app.get("/api/projects/:pid/resources/:resource", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const p = paging.parse(r.query);
    const resource = (r.params as any).resource;
    if (p.environmentId) await environment(pid, p.environmentId);
    const args: unknown[] = [pid, `%${p.q}%`];
    let sql = "";
    switch (resource) {
      case "environments":
        args.push(p.archived === "true");
        sql = `SELECT * FROM environments WHERE project_id=$1 AND (name ILIKE $2 OR base_url ILIKE $2) AND (archived_at IS NOT NULL)=$3 ORDER BY created_at DESC,id`;
        break;
      case "cases":
        sql = `SELECT * FROM test_cases WHERE project_id=$1 AND (title ILIKE $2 OR instructions ILIKE $2) ORDER BY created_at DESC,id`;
        break;
      case "knowledge":
        sql = `SELECT * FROM knowledge WHERE project_id=$1 AND (title ILIKE $2 OR content ILIKE $2) ORDER BY updated_at DESC,id`;
        break;
      case "team":
        sql = `SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND (u.name ILIKE $2 OR u.email ILIKE $2) ORDER BY u.name,u.id`;
        break;
      case "nodes":
        args.push(p.environmentId ?? null);
        sql = `SELECT * FROM (SELECT DISTINCT ON(n.id) n.id,n.id node_id,n.key,n.name,n.description,v.id revision_id,v.version,v.spec,v.created_at FROM nodes n JOIN node_versions v ON v.node_id=n.id WHERE n.project_id=$1 AND (n.name ILIKE $2 OR n.key ILIKE $2) AND v.environment_id=$3 ORDER BY n.id,v.version DESC) latest ORDER BY created_at DESC,id`;
        break;
      case "flows":
        args.push(p.environmentId ?? null);
        sql = `SELECT f.*,c.title case_title FROM flows f JOIN test_cases c ON c.id=f.case_id WHERE f.project_id=$1 AND (f.name ILIKE $2 OR c.title ILIKE $2) AND f.environment_id=$3 ORDER BY f.created_at DESC,f.id`;
        break;
      case "runs":
        args.push(p.environmentId ?? null);
        sql = `SELECT r.id,r.environment_id,r.case_id,r.flow_id,r.mode,r.status,r.summary,r.error,r.created_at,r.started_at,r.finished_at,c.title case_title FROM runs r JOIN test_cases c ON c.id=r.case_id WHERE r.project_id=$1 AND (c.title ILIKE $2 OR r.summary ILIKE $2 OR r.id::text ILIKE $2) AND r.environment_id=$3 ORDER BY r.created_at DESC,r.id`;
        break;
      default:
        throw new HttpError(404, "资源不存在");
    }
    const result = await pageResult(sql, args, p.page, p.pageSize);
    if (resource === "environments") result.items = result.items.map(safeEnv);
    return result;
  });
  app.post("/api/projects/:pid/environments/:eid/archive", async (r) => {
    const pid = path(r, "pid"),
      eid = path(r, "eid");
    await requireMember(pid, uid(r), true);
    await environment(pid, eid);
    const b = z.object({ archived: z.boolean() }).parse(r.body);
    return transaction(async (c) => {
      await c.query("SELECT id FROM environments WHERE id=$1 FOR UPDATE", [
        eid,
      ]);
      if (
        b.archived &&
        (
          await c.query(
            "SELECT 1 FROM runs WHERE environment_id=$1 AND status IN ('queued','running') LIMIT 1",
            [eid],
          )
        ).rowCount
      )
        throw new HttpError(409, "请等待或取消此环境中的任务后再归档");
      await c.query(
        "UPDATE environments SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1",
        [eid, b.archived],
      );
      return { ok: true };
    });
  });
  // Merge credentials server-side: the browser never receives existing values.
  app.patch("/api/projects/:pid/environments/:eid/secrets", async (r) => {
    const pid = path(r, "pid"),
      eid = path(r, "eid");
    await requireMember(pid, uid(r), true);
    await environment(pid, eid);
    const b = z
      .object({
        set: z.record(z.string().max(10000)).default({}),
        remove: z.array(z.string()).max(50).default([]),
      })
      .parse(r.body);
    return transaction(async (c) => {
      const env = (
        await c.query(
          "SELECT secrets_encrypted FROM environments WHERE id=$1 FOR UPDATE",
          [eid],
        )
      ).rows[0];
      const secrets = decryptSecrets(env.secrets_encrypted);
      b.remove.forEach((k) => delete secrets[k]);
      Object.assign(secrets, b.set);
      if (Object.keys(secrets).length > 50)
        throw new HttpError(400, "最多 50 个凭据");
      await c.query(
        "UPDATE environments SET secrets_encrypted=$2 WHERE id=$1",
        [eid, encryptSecrets(secrets)],
      );
      return { ok: true };
    });
  });
}
