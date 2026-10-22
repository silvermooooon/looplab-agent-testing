import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { one, query, transaction } from "./db.js";
import {
  HttpError,
  requireMember,
  environment,
  lockActiveScope,
} from "./repository.js";
import { validateAttachment } from "./chat-files.js";
import { cancelRun } from "./worker.js";
import { tokenHash } from "./security.js";
const uuid = z.string().uuid();
const uid = (r: FastifyRequest) => {
  if (!r.currentUser) throw new HttpError(401, "请先登录");
  return r.currentUser.id;
};
const path = (r: FastifyRequest, key: string) =>
  uuid.parse((r.params as any)[key]);
const runColumns =
  "id,events_complete,conversation_id,environment_id,case_id,flow_id,mode,status,summary,error,cancel_requested,created_at,finished_at";
async function session(r: FastifyRequest, edit = false) {
  const s = await one(
    "SELECT s.*,c.title case_title,c.instructions,c.is_draft,e.name environment_name FROM chat_sessions s JOIN test_cases c ON c.id=s.case_id JOIN environments e ON e.id=s.environment_id WHERE s.id=$1",
    [path(r, "sid")],
  );
  if (!s) throw new HttpError(404, "会话不存在");
  await requireMember(s.project_id, uid(r), edit);
  if (edit && s.archived_at) throw new HttpError(409, "会话已归档");
  return s;
}
export async function chatRoutes(app: FastifyInstance) {
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.get("/api/projects/:pid/chat/sessions", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const p = z
      .object({
        environmentId: uuid,
        page: z.coerce.number().int().min(1).default(1),
        q: z.string().max(100).default(""),
        archived: z.enum(["true", "false"]).default("false"),
      })
      .parse(r.query);
    await environment(pid, p.environmentId);
    const args = [pid, p.environmentId, "%" + p.q + "%", p.archived === "true"];
    const filter =
      "project_id=$1 AND environment_id=$2 AND title ILIKE $3 AND (archived_at IS NOT NULL)=$4";
    const [items, total] = await Promise.all([
      query(
        `SELECT id,title,case_id,repair_node_id,created_by,archived_at,updated_at FROM chat_sessions WHERE ${filter} ORDER BY updated_at DESC,id LIMIT 30 OFFSET $5`,
        [...args, (p.page - 1) * 30],
      ),
      one(
        `SELECT count(*)::int total FROM chat_sessions WHERE ${filter}`,
        args,
      ),
    ]);
    return { items, total: total!.total, page: p.page };
  });
  app.post("/api/projects/:pid/chat/sessions", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r), true);
    const b = z
      .object({
        environmentId: uuid,
        caseId: uuid.optional(),
        repairNodeId: uuid.optional(),
        title: z.string().trim().min(1).max(120).default("新对话"),
      })
      .parse(r.body);
    return transaction(async (c) => {
      await lockActiveScope(c, pid, b.environmentId);
      let caseId = b.caseId;
      if (b.repairNodeId) {
        const node = (
          await c.query("SELECT id FROM nodes WHERE id=$1 AND project_id=$2", [
            b.repairNodeId,
            pid,
          ])
        ).rows[0];
        if (!node) throw new HttpError(404, "节点不存在");
        if (!caseId) {
          const flow = (
            await c.query(
              `SELECT f.case_id FROM flows f WHERE f.project_id=$1 AND f.environment_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.steps) step JOIN node_versions v ON v.id=(step->>'revisionId')::uuid WHERE v.node_id=$3) ORDER BY f.created_at DESC LIMIT 1`,
              [pid, b.environmentId, b.repairNodeId],
            )
          ).rows[0];
          caseId = flow?.case_id;
        }
        if (!caseId)
          throw new HttpError(
            400,
            "此节点尚未被流程引用，请先在对话中生成包含它的测试流程",
          );
      }
      if (
        caseId &&
        !(
          await c.query(
            "SELECT id FROM test_cases WHERE id=$1 AND project_id=$2",
            [caseId, pid],
          )
        ).rowCount
      )
        throw new HttpError(404, "测试用例不存在");
      if (!caseId)
        caseId = (
          await c.query(
            "INSERT INTO test_cases(project_id,title,instructions,is_draft) VALUES($1,$2,'待对话确定测试目标',true) RETURNING id",
            [pid, b.title],
          )
        ).rows[0].id;
      return (
        await c.query(
          "INSERT INTO chat_sessions(project_id,environment_id,case_id,repair_node_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            pid,
            b.environmentId,
            caseId,
            b.repairNodeId ?? null,
            b.title,
            uid(r),
          ],
        )
      ).rows[0];
    });
  });
  app.get("/api/chat/sessions/:sid", async (r) => {
    const s = await session(r);
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse((r.query as any).before);
    const messages = await query(
      `SELECT m.*,u.name author_name,r.status,r.error,r.summary,r.flow_id FROM chat_messages m LEFT JOIN users u ON u.id=m.author_id JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR m.seq<$2) ORDER BY m.seq DESC LIMIT 50`,
      [s.id, before ?? null],
    );
    messages.reverse();
    const [attachments, runs, artifacts] = await Promise.all([
      query(
        "SELECT id,message_id,name,mime_type,size FROM chat_attachments WHERE conversation_id=$1 AND message_id=ANY($2::uuid[])",
        [s.id, messages.map((m) => m.id)],
      ),
      query(
        `SELECT ${runColumns} FROM runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 25`,
        [s.id],
      ),
      query(
        "SELECT a.id,a.run_id,a.name,a.mime_type FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.conversation_id=$1 AND a.run_id=ANY($2::uuid[]) ORDER BY a.created_at",
        [s.id, messages.map((m) => m.run_id)],
      ),
    ]);
    const draftAttachments = await query(
      "SELECT id,name,mime_type,size FROM chat_attachments WHERE conversation_id=$1 AND created_by=$2 AND message_id IS NULL ORDER BY created_at",
      [s.id, uid(r)],
    );
    return {
      session: s,
      draftAttachments,
      messages: messages.map((m) => ({
        ...m,
        attachments: attachments.filter((a) => a.message_id === m.id),
      })),
      runs,
      artifacts,
      hasOlder: messages.length === 50,
    };
  });
  app.patch("/api/chat/sessions/:sid", async (r) => {
    const s = await session(r);
    await requireMember(s.project_id, uid(r), true);
    const b = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        archived: z.boolean().optional(),
      })
      .parse(r.body);
    return transaction(async (c) => {
      await c.query("SELECT id FROM chat_sessions WHERE id=$1 FOR UPDATE", [
        s.id,
      ]);
      if (
        b.archived &&
        (
          await c.query(
            "SELECT 1 FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
            [s.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "请先停止正在执行的任务");
      await c.query(
        "UPDATE chat_sessions SET title=COALESCE($2,title),archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",
        [s.id, b.title ?? null, b.archived ?? null],
      );
      return { ok: true };
    });
  });
  app.post(
    "/api/chat/sessions/:sid/attachments",
    { bodyLimit: 8 * 1024 * 1024 },
    async (r) => {
      const s = await session(r, true);
      const b = z
        .object({
          name: z.string().min(1).max(255),
          data: z.string().max(7 * 1024 * 1024),
        })
        .parse(r.body);
      const f = validateAttachment(b.name, b.data);
      return transaction(async (c) => {
        await lockActiveScope(c, s.project_id, s.environment_id);
        const locked = (
          await c.query(
            "SELECT archived_at FROM chat_sessions WHERE id=$1 FOR UPDATE",
            [s.id],
          )
        ).rows[0];
        if (locked.archived_at) throw new HttpError(409, "会话已归档");
        const total = (
          await c.query(
            "SELECT COALESCE(sum(size),0)::bigint total,count(*)::int count FROM chat_attachments WHERE conversation_id=$1",
            [s.id],
          )
        ).rows[0];
        if (
          Number(total.total) + f.data.length > 50 * 1024 * 1024 ||
          total.count >= 100
        )
          throw new HttpError(
            400,
            "此会话附件已达上限（50 MB / 100 个），请新建会话",
          );
        return (
          await c.query(
            "INSERT INTO chat_attachments(conversation_id,created_by,name,mime_type,size,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,mime_type,size",
            [s.id, uid(r), f.filename, f.mime, f.data.length, f.data],
          )
        ).rows[0];
      });
    },
  );
  app.delete("/api/chat/sessions/:sid/attachments/:aid", async (r) => {
    const s = await session(r, true);
    await query(
      "DELETE FROM chat_attachments WHERE id=$1 AND conversation_id=$2 AND created_by=$3 AND message_id IS NULL",
      [path(r, "aid"), s.id, uid(r)],
    );
    return { ok: true };
  });
  app.get("/api/chat/attachments/:aid", async (r, reply) => {
    const file = await one(
      "SELECT a.*,s.project_id FROM chat_attachments a JOIN chat_sessions s ON s.id=a.conversation_id WHERE a.id=$1",
      [path(r, "aid")],
    );
    if (!file) throw new HttpError(404, "附件不存在");
    await requireMember(file.project_id, uid(r));
    reply
      .type(file.mime_type)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header(
      "Content-Disposition",
      `${file.mime_type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    return file.data;
  });
  app.post("/api/chat/sessions/:sid/messages", async (r) => {
    const s = await session(r, true);
    const b = z
      .object({
        text: z.string().trim().max(20000).default(""),
        attachmentIds: z.array(uuid).max(5).default([]),
        clientId: uuid,
      })
      .refine(
        (b) => b.text.length || b.attachmentIds.length,
        "请输入文字或添加附件",
      )
      .parse(r.body);
    return transaction(async (c) => {
      await lockActiveScope(c, s.project_id, s.environment_id);
      const locked = (
        await c.query(
          "SELECT archived_at FROM chat_sessions WHERE id=$1 FOR UPDATE",
          [s.id],
        )
      ).rows[0];
      if (locked.archived_at) throw new HttpError(409, "会话已归档");
      const duplicate = (
        await c.query(
          "SELECT run_id FROM chat_messages WHERE conversation_id=$1 AND author_id=$2 AND client_id=$3",
          [s.id, uid(r), b.clientId],
        )
      ).rows[0];
      if (duplicate) return { runId: duplicate.run_id, reused: true };
      if (
        (
          await c.query(
            "SELECT 1 FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
            [s.id],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "Agent 正在处理上一条消息，请等待或先停止执行",
        );
      const files = (
        await c.query(
          "SELECT id,size FROM chat_attachments WHERE id=ANY($1::uuid[]) AND conversation_id=$2 AND created_by=$3 AND message_id IS NULL",
          [[...new Set(b.attachmentIds)], s.id, uid(r)],
        )
      ).rows;
      if (files.length !== b.attachmentIds.length)
        throw new HttpError(400, "附件不存在、重复或不属于当前会话");
      if (files.reduce((n, f) => n + f.size, 0) > 12 * 1024 * 1024)
        throw new HttpError(400, "单条消息附件合计不能超过 12 MB");
      const run = (
        await c.query(
          "INSERT INTO runs(project_id,environment_id,case_id,mode,repair_node_id,requested_by,conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            s.project_id,
            s.environment_id,
            s.case_id,
            s.repair_node_id ? "repair" : "generate",
            s.repair_node_id,
            uid(r),
            s.id,
          ],
        )
      ).rows[0];
      const user = (
        await c.query(
          "INSERT INTO chat_messages(conversation_id,role,content,run_id,author_id,client_id) VALUES($1,'user',$2,$3,$4,$5) RETURNING id",
          [s.id, b.text, run.id, uid(r), b.clientId],
        )
      ).rows[0];
      await c.query(
        "UPDATE chat_attachments SET message_id=$1 WHERE id=ANY($2::uuid[])",
        [user.id, b.attachmentIds],
      );
      await c.query(
        "INSERT INTO chat_messages(conversation_id,role,run_id) VALUES($1,'assistant',$2)",
        [s.id, run.id],
      );
      await c.query(
        "UPDATE chat_sessions SET updated_at=now(),title=CASE WHEN title='新对话' THEN $2 ELSE title END WHERE id=$1",
        [s.id, (b.text || files.length + " 个附件").slice(0, 60)],
      );
      return { runId: run.id };
    });
  });
  app.post("/api/chat/sessions/:sid/runs/:rid/cancel", async (r) => {
    const s = await session(r, true);
    const run = await one(
      "SELECT id FROM runs WHERE id=$1 AND conversation_id=$2",
      [path(r, "rid"), s.id],
    );
    if (!run) throw new HttpError(404, "任务不存在");
    await cancelRun(run.id);
    return { ok: true };
  });
  app.get("/api/chat/sessions/:sid/runs/:rid/stream", async (r, reply) => {
    const s = await session(r);
    const rid = path(r, "rid");
    if (
      !(await one("SELECT id FROM runs WHERE id=$1 AND conversation_id=$2", [
        rid,
        s.id,
      ]))
    )
      throw new HttpError(404, "任务不存在");
    let cursor = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(r.headers["last-event-id"] || (r.query as any).after);
    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 1500\n\n");
    let lastState = "",
      checkedAt = 0,
      heartbeat = Date.now();
    try {
      while (!closed && !closing) {
        if (Date.now() - checkedAt > 5000) {
          const member = await one(
            "SELECT 1 FROM members m JOIN sessions s ON s.user_id=m.user_id WHERE m.project_id=$1 AND s.token_hash=$2 AND s.expires_at>now()",
            [s.project_id, tokenHash(r.cookies.qa_session ?? "")],
          );
          if (!member) {
            reply.raw.write("event: forbidden\ndata: {}\n\n");
            break;
          }
          checkedAt = Date.now();
        }
        const [run, events] = await Promise.all([
          one(`SELECT ${runColumns} FROM runs WHERE id=$1`, [rid]),
          query(
            "SELECT id,kind,data,created_at FROM run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 200",
            [rid, cursor],
          ),
        ]);
        if (events.length) cursor = Number(events.at(-1)!.id);
        const state = JSON.stringify(run);
        if (events.length || state !== lastState) {
          const payload = JSON.stringify({
            run,
            events,
            cursor,
            hasMore: events.length === 200,
          });
          if (
            !reply.raw.write(
              `id: ${cursor}\nevent: update\ndata: ${payload}\n\n`,
            )
          ) {
            // Bound per-connection buffered output; reconnect resumes from the last received cursor.
            reply.raw.end();
            break;
          }
          lastState = state;
        }
        if (
          run?.events_complete &&
          !["queued", "running"].includes(run.status) &&
          events.length < 200
        ) {
          reply.raw.write("event: done\ndata: {}\n\n");
          break;
        }
        if (Date.now() - heartbeat > 15000) {
          reply.raw.write(": heartbeat\n\n");
          heartbeat = Date.now();
        }
        if (events.length < 200)
          await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch {
      if (!closed) reply.raw.write("event: reconnect\ndata: {}\n\n");
    } finally {
      reply.raw.end();
    }
  });
}
