import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, one, transaction } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  tokenHash,
  encryptSecrets,
  decryptSecrets,
} from "./security.js";
import { config } from "./config.js";
import {
  HttpError,
  requireMember,
  environment,
  activeEnvironment,
  lockActiveScope,
  latestNodes,
  saveNode,
  saveFlow,
  resolveSteps,
} from "./repository.js";
import { specSchema, flowSchema } from "../testing/spec.js";
import { exportScript } from "../testing/export.js";
import { cancelRun } from "./worker.js";

const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const credentials = z
  .record(z.string().max(10000))
  .refine((v) => Object.keys(v).length <= 50);
const url = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) =>
      ["http:", "https:"].includes(new URL(value).protocol) &&
      !new URL(value).username &&
      !new URL(value).password,
    "请输入 HTTP/HTTPS 地址，不要在 URL 中嵌入凭据",
  );
const envInput = z
  .object({
    name,
    baseUrl: url,
    variables: credentials.default({}),
    secrets: credentials.optional(),
    secretChanges: z
      .object({
        set: credentials.default({}),
        remove: z.array(z.string()).max(50).default([]),
      })
      .optional(),
  })
  .strict();
declare module "fastify" {
  interface FastifyRequest {
    currentUser?: { id: string; email: string; name: string };
  }
}

export async function routes(app: FastifyInstance) {
  const uid = (r: FastifyRequest) => {
    if (!r.currentUser) throw new HttpError(401, "请先登录");
    return r.currentUser.id;
  };
  const path = (r: FastifyRequest, key: string) =>
    id.parse((r.params as Record<string, string>)[key]);
  async function session(reply: any, user: any) {
    const token = randomBytes(32).toString("hex");
    await query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [tokenHash(token), user.id],
    );
    reply.setCookie("qa_session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookie,
      maxAge: 604800,
    });
    return { id: user.id, email: user.email, name: user.name };
  }
  app.addHook("preHandler", async (r) => {
    if (!r.url.startsWith("/api/")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method)) {
      const origin = r.headers.origin;
      if (origin && new URL(origin).host !== r.headers.host)
        throw new HttpError(403, "跨站请求已拒绝");
    }
    const token = r.cookies.qa_session;
    if (token)
      r.currentUser = await one(
        `SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
        [tokenHash(token)],
      );
    if (
      ![
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/me",
        "/api/health",
      ].includes(r.url.split("?")[0]!)
    )
      uid(r);
  });
  app.get("/api/health", async () => ({
    ok: true,
    model: "gpt-6-luna",
    database: !!(await one("SELECT 1")),
  }));
  app.get("/api/auth/me", async (r) => ({ user: r.currentUser ?? null }));
  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r, reply) => {
      const body = z
        .object({
          name,
          email: z
            .string()
            .email()
            .max(200)
            .transform((s) => s.toLowerCase()),
          password: z.string().min(10).max(128),
        })
        .parse(r.body);
      const user = await one(
        "INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id,email,name",
        [body.email, body.name, hashPassword(body.password)],
      );
      return { user: await session(reply, user) };
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (r, reply) => {
      const body = z
        .object({
          email: z
            .string()
            .email()
            .transform((s) => s.toLowerCase()),
          password: z.string().max(128),
        })
        .parse(r.body);
      const user = await one("SELECT * FROM users WHERE email=$1", [
        body.email,
      ]);
      if (!user || !verifyPassword(body.password, user.password_hash))
        throw new HttpError(401, "邮箱或密码错误");
      return { user: await session(reply, user) };
    },
  );
  app.post("/api/auth/logout", async (r, reply) => {
    await query("DELETE FROM sessions WHERE token_hash=$1", [
      tokenHash(r.cookies.qa_session ?? ""),
    ]);
    reply.clearCookie("qa_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/projects", async (r) =>
    query(
      "SELECT p.*,m.role FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC",
      [uid(r)],
    ),
  );
  app.post("/api/projects", async (r) => {
    const body = z
      .object({ name, description: z.string().max(4000).default("") })
      .parse(r.body);
    return transaction(async (c) => {
      const project = (
        await c.query(
          "INSERT INTO projects(name,description) VALUES($1,$2) RETURNING *",
          [body.name, body.description],
        )
      ).rows[0];
      await c.query("INSERT INTO members VALUES($1,$2,'owner')", [
        project.id,
        uid(r),
      ]);
      return project;
    });
  });
  app.get("/api/projects/:pid", async (r) => {
    const pid = path(r, "pid");
    const role = await requireMember(pid, uid(r));
    const requested = (r.query as { environmentId?: string }).environmentId;
    const envs = await query(
      "SELECT * FROM environments WHERE project_id=$1 ORDER BY created_at",
      [pid],
    );
    const selected = requested ? id.parse(requested) : envs[0]?.id;
    if (selected) await environment(pid, selected);
    const [project, knowledge, cases, flows, runs, members, nodes] =
      await Promise.all([
        one("SELECT * FROM projects WHERE id=$1", [pid]),
        query(
          "SELECT * FROM knowledge WHERE project_id=$1 ORDER BY updated_at DESC",
          [pid],
        ),
        query(
          "SELECT * FROM test_cases WHERE project_id=$1 AND NOT is_draft ORDER BY created_at DESC",
          [pid],
        ),
        query(
          "SELECT * FROM flows WHERE project_id=$1 AND environment_id=$2 ORDER BY created_at DESC",
          [pid, selected ?? null],
        ),
        query(
          "SELECT id,environment_id,case_id,flow_id,mode,status,summary,error,created_at,started_at,finished_at FROM runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 80",
          [pid],
        ),
        query(
          "SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.name",
          [pid],
        ),
        selected ? latestNodes(pid, selected) : Promise.resolve([]),
      ]);
    return {
      project,
      role,
      environmentId: selected,
      environments: envs.map(({ secrets_encrypted, ...e }) => ({
        ...e,
        secretKeys: Object.keys(decryptSecrets(secrets_encrypted)),
      })),
      knowledge,
      cases,
      flows,
      runs,
      members,
      nodes,
    };
  });
  app.post("/api/projects/:pid/members", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true, true);
    const body = z
      .object({
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase()),
        role: z.enum(["editor", "viewer"]),
      })
      .parse(r.body);
    const user = await one("SELECT id FROM users WHERE email=$1", [body.email]);
    if (!user) throw new HttpError(404, "请让该成员先注册账户");
    const existing = await one(
      "SELECT role FROM members WHERE project_id=$1 AND user_id=$2",
      [pid, user.id],
    );
    if (existing?.role === "owner")
      throw new HttpError(400, "不能修改所有者角色");
    await query(
      "INSERT INTO members VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role",
      [pid, user.id, body.role],
    );
    return { ok: true };
  });
  app.delete("/api/projects/:pid/members/:mid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true, true);
    await query(
      "DELETE FROM members WHERE project_id=$1 AND user_id=$2 AND role<>'owner'",
      [pid, path(r, "mid")],
    );
    return { ok: true };
  });
  app.post("/api/projects/:pid/environments", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const body = envInput.parse(r.body);
    const env = await one(
      "INSERT INTO environments(project_id,name,base_url,variables,secrets_encrypted) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        pid,
        body.name,
        body.baseUrl,
        JSON.stringify(body.variables),
        encryptSecrets(body.secrets ?? {}),
      ],
    );
    return env;
  });
  app.put("/api/projects/:pid/environments/:eid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const env = await activeEnvironment(pid, path(r, "eid"));
    const body = envInput.parse(r.body);
    await transaction(async (c) => {
      const current = (
        await c.query(
          "SELECT secrets_encrypted FROM environments WHERE id=$1 FOR UPDATE",
          [env.id],
        )
      ).rows[0];
      const secrets = body.secrets ?? decryptSecrets(current.secrets_encrypted);
      body.secretChanges?.remove.forEach((key) => delete secrets[key]);
      Object.assign(secrets, body.secretChanges?.set ?? {});
      if (Object.keys(secrets).length > 50)
        throw new HttpError(400, "最多 50 个凭据");
      await c.query(
        "UPDATE environments SET name=$1,base_url=$2,variables=$3,secrets_encrypted=$4 WHERE id=$5",
        [
          body.name,
          body.baseUrl,
          JSON.stringify(body.variables),
          encryptSecrets(secrets),
          env.id,
        ],
      );
    });
    return { ok: true };
  });
  app.post("/api/projects/:pid/environments/:eid/clone", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const source = await activeEnvironment(pid, path(r, "eid"));
    const body = z
      .object({ name, baseUrl: url, copySecrets: z.boolean().default(false) })
      .parse(r.body);
    return transaction(async (c) => {
      const env = (
        await c.query(
          "INSERT INTO environments(project_id,name,base_url,variables,secrets_encrypted) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            pid,
            body.name,
            body.baseUrl,
            source.variables,
            body.copySecrets ? source.secrets_encrypted : encryptSecrets({}),
          ],
        )
      ).rows[0];
      const revisions = (
        await c.query("SELECT * FROM node_versions WHERE environment_id=$1", [
          source.id,
        ])
      ).rows;
      const mapping = new Map<string, string>();
      for (const rev of revisions) {
        const next = randomUUID();
        mapping.set(rev.id, next);
        await c.query(
          "INSERT INTO node_versions(id,node_id,environment_id,version,spec,source,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            next,
            rev.node_id,
            env.id,
            rev.version,
            rev.spec,
            rev.source,
            uid(r),
          ],
        );
      }
      const flows = (
        await c.query(
          "SELECT * FROM flows WHERE environment_id=$1 AND project_id=$2",
          [source.id, pid],
        )
      ).rows;
      for (const flow of flows) {
        const steps = flowSchema
          .parse(flow.steps)
          .map((s) => ({ ...s, revisionId: mapping.get(s.revisionId)! }));
        await c.query(
          "INSERT INTO flows(project_id,environment_id,case_id,name,steps,created_by) VALUES($1,$2,$3,$4,$5,$6)",
          [pid, env.id, flow.case_id, flow.name, JSON.stringify(steps), uid(r)],
        );
      }
      return {
        id: env.id,
        copiedRevisions: revisions.length,
        copiedFlows: flows.length,
      };
    });
  });
  app.post("/api/projects/:pid/knowledge", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({ title: name, content: z.string().min(1).max(60000) })
      .parse(r.body);
    return one(
      "INSERT INTO knowledge(project_id,title,content) VALUES($1,$2,$3) RETURNING *",
      [pid, b.title, b.content],
    );
  });
  app.put("/api/projects/:pid/knowledge/:kid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({ title: name, content: z.string().min(1).max(60000) })
      .parse(r.body);
    return one(
      "UPDATE knowledge SET title=$1,content=$2,updated_at=now() WHERE id=$3 AND project_id=$4 RETURNING *",
      [b.title, b.content, path(r, "kid"), pid],
    );
  });
  app.delete("/api/projects/:pid/knowledge/:kid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    await query("DELETE FROM knowledge WHERE id=$1 AND project_id=$2", [
      path(r, "kid"),
      pid,
    ]);
    return { ok: true };
  });
  app.post("/api/projects/:pid/cases", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({ title: name, instructions: z.string().min(1).max(20000) })
      .parse(r.body);
    return one(
      "INSERT INTO test_cases(project_id,title,instructions) VALUES($1,$2,$3) RETURNING *",
      [pid, b.title, b.instructions],
    );
  });
  app.put("/api/projects/:pid/cases/:cid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({ title: name, instructions: z.string().min(1).max(20000) })
      .parse(r.body);
    return one(
      "UPDATE test_cases SET title=$1,instructions=$2 WHERE id=$3 AND project_id=$4 RETURNING *",
      [b.title, b.instructions, path(r, "cid"), pid],
    );
  });
  app.post("/api/projects/:pid/nodes", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({
        environmentId: id,
        key: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
        name,
        description: z.string().max(4000).default(""),
        spec: specSchema,
      })
      .parse(r.body);
    return saveNode(pid, b.environmentId, uid(r), b);
  });
  app.get("/api/projects/:pid/nodes/:nid/versions", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    return query(
      "SELECT v.* FROM node_versions v JOIN nodes n ON n.id=v.node_id WHERE n.id=$1 AND n.project_id=$2 ORDER BY v.created_at DESC",
      [path(r, "nid"), pid],
    );
  });
  app.post("/api/projects/:pid/flows", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({ environmentId: id, caseId: id, name, steps: flowSchema })
      .parse(r.body);
    return saveFlow(pid, b.environmentId, b.caseId, uid(r), b.name, b.steps);
  });
  app.get("/api/projects/:pid/flows/:fid/export", async (r, reply) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const flow = await one(
      "SELECT * FROM flows WHERE id=$1 AND project_id=$2",
      [path(r, "fid"), pid],
    );
    if (!flow) throw new HttpError(404, "流程不存在");
    const nodes = await resolveSteps(pid, flow.environment_id, flow.steps);
    reply
      .header("Content-Disposition", 'attachment; filename="flow.ts"')
      .type("text/plain");
    return exportScript(nodes);
  });
  app.post("/api/projects/:pid/runs", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({
        environmentId: id,
        caseId: id,
        mode: z.enum(["generate", "execute", "repair"]),
        flowId: id.optional(),
        repairNodeId: id.optional(),
      })
      .parse(r.body);
    await activeEnvironment(pid, b.environmentId);
    if (
      !(await one("SELECT id FROM test_cases WHERE id=$1 AND project_id=$2", [
        b.caseId,
        pid,
      ]))
    )
      throw new HttpError(404, "测试用例不存在");
    if (b.mode === "execute") {
      const flow = await one(
        "SELECT * FROM flows WHERE id=$1 AND project_id=$2 AND environment_id=$3 AND case_id=$4",
        [b.flowId, pid, b.environmentId, b.caseId],
      );
      if (!flow) throw new HttpError(400, "请选择对应环境和用例的流程");
    }
    if (
      b.mode === "repair" &&
      !(await one("SELECT id FROM nodes WHERE id=$1 AND project_id=$2", [
        b.repairNodeId,
        pid,
      ]))
    )
      throw new HttpError(400, "请选择待修复节点");
    return transaction(async (c) => {
      await lockActiveScope(c, pid, b.environmentId);
      return (
        await c.query(
          "INSERT INTO runs(project_id,environment_id,case_id,mode,flow_id,repair_node_id,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            pid,
            b.environmentId,
            b.caseId,
            b.mode,
            b.flowId ?? null,
            b.repairNodeId ?? null,
            uid(r),
          ],
        )
      ).rows[0];
    });
  });
  app.get("/api/runs/:rid", async (r) => {
    const run = await one(
      "SELECT r.*,c.title AS case_title,e.name AS environment_name FROM runs r JOIN test_cases c ON c.id=r.case_id JOIN environments e ON e.id=r.environment_id WHERE r.id=$1",
      [path(r, "rid")],
    );
    if (!run) throw new HttpError(404, "运行不存在");
    await requireMember(run.project_id, uid(r));
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse((r.query as any).after);
    const incremental = (r.query as any).incremental === "true";
    const events = await query(
      "SELECT id,kind,data,created_at FROM run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT $3",
      [run.id, after, incremental ? 250 : 10000],
    );
    const { snapshot, ...summary } = run;
    return {
      run: incremental ? summary : run,
      nextCursor: events.at(-1)?.id ?? String(after),
      hasMore: events.length === (incremental ? 250 : 10000),
      events,
      artifacts: await query(
        "SELECT id,name,mime_type,created_at FROM artifacts WHERE run_id=$1 ORDER BY created_at",
        [run.id],
      ),
    };
  });
  app.post("/api/runs/:rid/cancel", async (r) => {
    const run = await one(
      "SELECT r.*,c.title AS case_title,e.name AS environment_name FROM runs r JOIN test_cases c ON c.id=r.case_id JOIN environments e ON e.id=r.environment_id WHERE r.id=$1",
      [path(r, "rid")],
    );
    if (!run) throw new HttpError(404, "运行不存在");
    await requireMember(run.project_id, uid(r), true);
    await cancelRun(run.id);
    return { ok: true };
  });
  app.get("/api/artifacts/:aid", async (r, reply) => {
    const row = await one(
      "SELECT a.*,r.project_id FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=$1",
      [path(r, "aid")],
    );
    if (!row) throw new HttpError(404, "附件不存在");
    await requireMember(row.project_id, uid(r));
    reply.type(row.mime_type).header("Cache-Control", "private, no-store");
    return row.data;
  });
}
