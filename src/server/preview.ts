import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BrowserSession } from "../testing/browser.js";
import { one, query } from "./db.js";
import { HttpError, requireMember } from "./repository.js";
import { redact } from "./security.js";

export function startRunPreview(
  runId: string,
  browser: BrowserSession,
  phase: "investigation" | "replay",
  secrets: Record<string, string>,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = "";
  const capture = async () => {
    const lease = await one(
      "SELECT requested_at > now()-interval '3 seconds' AS active FROM run_previews WHERE run_id=$1",
      [runId],
    );
    if (stopped) return;
    if (!lease?.active) {
      if (lease)
        await query(
          "DELETE FROM run_previews WHERE run_id=$1 AND requested_at <= now()-interval '3 seconds'",
          [runId],
        );
      lastFrame = "";
      return;
    }
    const frame = await browser.previewFrame();
    if (stopped) return;
    if (frame.state !== "ready") {
      await query(
        "UPDATE run_previews SET state=$2 WHERE run_id=$1 AND state<>$2",
        [runId, frame.state],
      );
      lastFrame = "";
      return;
    }
    const { capturedAt, ...details } = frame.meta;
    const meta = redact({ phase, ...details }, secrets) as typeof details & {
      phase: typeof phase;
    };
    meta.path = meta.path.slice(0, 500);
    if (meta.action?.selector)
      meta.action.selector = meta.action.selector.slice(0, 300);
    const frameId = createHash("sha256")
      .update(frame.data)
      .update(JSON.stringify(meta))
      .digest("hex");
    if (lastFrame === frameId) return;
    await query(
      "UPDATE run_previews SET state='ready',frame_id=$2,meta=$3,data=$4 WHERE run_id=$1",
      [runId, frameId, JSON.stringify({ ...meta, capturedAt }), frame.data],
    );
    lastFrame = frameId;
  };
  const tick = async () => {
    await capture().catch(() => {});
    if (!stopped) timer = setTimeout(tick, 500);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function previewRoutes(app: FastifyInstance) {
  app.get<{ Params: { rid: string } }>(
    "/api/runs/:rid/preview",
    async (r, reply) => {
      if (!r.currentUser) throw new HttpError(401, "请先登录");
      const id = z.string().uuid().parse(r.params.rid);
      const run = await one<{ project_id: string; status: string }>(
        "SELECT project_id,status FROM runs WHERE id=$1",
        [id],
      );
      if (!run) throw new HttpError(404, "运行不存在");
      await requireMember(run.project_id, r.currentUser.id);
      reply.header("Cache-Control", "private, no-store");
      if (run.status !== "running") {
        return reply
          .header(
            "X-Preview-State",
            run.status === "queued" ? "waiting" : "ended",
          )
          .code(204)
          .send();
      }
      const validator = r.headers["if-none-match"] ?? "";
      const frame = await one<{
        state: "waiting" | "ready" | "dialog";
        frame_id: string | null;
        meta: unknown;
        data: Buffer | null;
      }>(
        `INSERT INTO run_previews(run_id)
       SELECT id FROM runs WHERE id=$1 AND status='running' FOR SHARE
       ON CONFLICT (run_id) DO UPDATE SET requested_at=now()
       RETURNING state,frame_id,meta,
         CASE WHEN state='ready' AND concat('"',frame_id,'"') <> $2 THEN data END AS data`,
        [id, validator],
      );
      if (!frame || frame.state !== "ready") {
        return reply
          .header("X-Preview-State", frame?.state ?? "ended")
          .code(204)
          .send();
      }
      reply.header("ETag", `"${frame.frame_id}"`);
      if (!frame.data) return reply.code(304).send();
      return reply
        .header(
          "X-Preview-Meta",
          encodeURIComponent(JSON.stringify(frame.meta)),
        )
        .type("image/jpeg")
        .send(frame.data);
    },
  );
}
