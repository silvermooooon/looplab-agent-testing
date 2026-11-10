import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BrowserSession } from "../testing/browser.js";
import { query, one } from "./db.js";
import { HttpError, requireMember } from "./repository.js";
import { redact } from "./security.js";

type Dialog = { type: string; message: string; defaultValue: string };
type InterventionInfo = { message: string; trigger: string; dialog?: Dialog };
type Log = (kind: string, data: unknown) => Promise<void>;

const typeAction = z
  .object({ type: z.literal("type"), text: z.string().max(10000) })
  .strict();
const pressAction = z
  .object({ type: z.literal("press"), key: z.string().min(1).max(100) })
  .strict();
const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      x: z.number().min(0).max(1440),
      y: z.number().min(0).max(960),
    })
    .strict(),
  typeAction,
  pressAction,
  z
    .object({
      type: z.literal("keyboard"),
      steps: z
        .array(z.discriminatedUnion("type", [typeAction, pressAction]))
        .min(1)
        .max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaY: z.number().min(-5000).max(5000),
    })
    .strict(),
  z
    .object({
      type: z.literal("dialogAccept"),
      text: z.string().max(10000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("dialogDismiss") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
]);
type InterventionCommand = {
  id: string;
  action: z.infer<typeof actionSchema> | { type: "screenshot" };
};

export async function runIntervention(
  runId: string,
  browser: BrowserSession,
  info: InterventionInfo,
  signal: AbortSignal,
  log: Log,
  secrets: Record<string, string>,
) {
  info = redact(info, secrets) as InterventionInfo;
  await query(
    "INSERT INTO run_interventions(run_id,info) VALUES($1,$2) ON CONFLICT(run_id) DO UPDATE SET info=EXCLUDED.info,created_at=now()",
    [runId, JSON.stringify(info)],
  );
  await log("intervention", { status: "waiting", ...info });
  await log("agent_status", {
    stage: "human",
    message: "正在等待人工处理目标页面",
  });
  let currentDialog = JSON.stringify(info.dialog ?? null);
  const syncDialog = async () => {
    const dialog = redact(browser.manualDialog(), secrets) as
      Dialog | undefined;
    const nextDialog = JSON.stringify(dialog ?? null);
    if (currentDialog !== nextDialog) {
      currentDialog = nextDialog;
      info = {
        message: info.message,
        trigger: info.trigger,
        ...(dialog ? { dialog } : {}),
      };
      await query("UPDATE run_interventions SET info=$2 WHERE run_id=$1", [
        runId,
        JSON.stringify(info),
      ]);
    }
  };
  let inFlight: Promise<boolean> | undefined;
  const execute = async (command: InterventionCommand): Promise<boolean> => {
    const action = command.action;
    try {
      let data: Buffer | undefined;
      if (action.type === "resume") {
        if (browser.manualDialog())
          throw new Error("请先处理浏览器弹框，再继续运行");
        if (inFlight) throw new Error("页面操作尚未完成，请稍后继续");
      } else if (action.type === "screenshot") {
        if (inFlight && !browser.manualDialog())
          throw new Error("页面操作进行中，请稍后刷新截图");
        data = await browser.manualScreenshot();
      } else {
        if (action.type === "keyboard")
          await browser.manualKeyboard(action.steps);
        else await browser.manualAction(action);
        await syncDialog();
        await log("intervention_action", { type: action.type });
      }
      if (action.type === "resume")
        await query("DELETE FROM run_interventions WHERE run_id=$1", [runId]);
      await query(
        "UPDATE intervention_commands SET status='done',action='{}',data=$2 WHERE id=$1",
        [command.id, data ?? null],
      );
      if (action.type === "resume") {
        await log("intervention", {
          status: "resumed",
          message: "人工处理完成，继续执行",
        });
        await log("agent_status", {
          stage: "testing",
          message: "人工处理完成，继续执行",
        });
        return true;
      }
    } catch (error) {
      const inputError =
        action.type === "keyboard" && browser.manualDialog()
          ? "请先处理浏览器弹框，再继续输入"
          : "输入未能完成，请检查页面状态后重试";
      await query(
        "UPDATE intervention_commands SET status='failed',action='{}',error=$2 WHERE id=$1",
        [
          command.id,
          ["type", "keyboard", "dialogAccept"].includes(action.type)
            ? inputError
            : redact(
                error instanceof Error ? error.message : "操作失败",
                secrets,
              ),
        ],
      );
    }
    return false;
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      await syncDialog();
      const command = await one<InterventionCommand>(
        `UPDATE intervention_commands SET status='processing' WHERE id=(
          SELECT id FROM intervention_commands WHERE run_id=$1 AND status='pending' ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id,action`,
        [runId],
      );
      if (!command) {
        await delay(200, undefined, { signal });
        continue;
      }
      const action = command.action;
      if (
        ["click", "type", "press", "keyboard", "scroll"].includes(action.type)
      ) {
        if (inFlight) {
          await query(
            "UPDATE intervention_commands SET status='failed',action='{}',error='页面操作尚未完成' WHERE id=$1",
            [command.id],
          );
          continue;
        }
        const pending = execute(command);
        inFlight = pending;
        void pending
          .finally(() => {
            if (inFlight === pending) inFlight = undefined;
          })
          .catch(() => {});
      } else if (await execute(command)) {
        return;
      }
    }
  } finally {
    await query("DELETE FROM run_interventions WHERE run_id=$1", [runId]);
    await query(
      "UPDATE intervention_commands SET status='failed',action='{}',error='人工接管已结束' WHERE run_id=$1 AND status IN ('pending','processing')",
      [runId],
    );
  }
}

export function interventionRoutes(app: FastifyInstance) {
  const getRun = async (r: FastifyRequest, edit = false) => {
    const id = z
      .string()
      .uuid()
      .parse((r.params as Record<string, string>).rid);
    const run = await one("SELECT id,project_id,status FROM runs WHERE id=$1", [
      id,
    ]);
    if (!run) throw new HttpError(404, "运行不存在");
    if (!r.currentUser) throw new HttpError(401, "请先登录");
    await requireMember(run.project_id, r.currentUser.id, edit);
    return run;
  };
  const send = async (runId: string, action: unknown) => {
    const command = await one(
      `INSERT INTO intervention_commands(run_id,action)
       SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM run_interventions WHERE run_id=$1)
       RETURNING id`,
      [runId, JSON.stringify(action)],
    );
    if (!command) throw new HttpError(409, "当前运行没有等待人工处理");
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const result = await one(
        "DELETE FROM intervention_commands WHERE id=$1 AND status IN ('done','failed') RETURNING status,error,data",
        [command.id],
      );
      if (result) {
        if (result.status === "failed")
          throw new HttpError(409, result.error || "人工操作失败");
        return result.data as Buffer | null;
      }
      await delay(150);
    }
    await query(
      "UPDATE intervention_commands SET action='{}',status=CASE WHEN status='pending' THEN 'failed' ELSE status END,error=CASE WHEN status='pending' THEN '人工操作超时' ELSE error END WHERE id=$1",
      [command.id],
    );
    throw new HttpError(504, "执行器未及时响应人工操作，请检查运行状态");
  };
  app.get("/api/runs/:rid/intervention", async (r) => {
    const run = await getRun(r);
    const row = await one(
      "SELECT info FROM run_interventions WHERE run_id=$1",
      [run.id],
    );
    return {
      active: !!row && run.status === "running",
      info: row?.info ?? null,
    };
  });
  app.get("/api/runs/:rid/intervention/screenshot", async (r, reply) => {
    const run = await getRun(r);
    const data = await send(run.id, { type: "screenshot" });
    if (!data) throw new HttpError(409, "当前页面截图不可用");
    reply.type("image/png").header("Cache-Control", "private, no-store");
    return data;
  });
  app.post("/api/runs/:rid/intervention/actions", async (r) => {
    const run = await getRun(r, true);
    await send(run.id, actionSchema.parse(r.body));
    return { ok: true };
  });
}
