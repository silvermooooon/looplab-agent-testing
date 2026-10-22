import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { pool, query } from "../src/server/db.js";
const credentials = JSON.parse(
  await readFile(".data/acceptance-credentials.json", "utf8"),
);
const previous = JSON.parse(
  await readFile(".data/acceptance-result.json", "utf8"),
);
const base = credentials.baseUrl;
let cookie = "";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const data = await r.json();
  assert.equal(r.status, status, data.error);
  return data;
}
await request("/auth/login", "POST", credentials.owner);
const original = (await request("/runs/" + previous.runIds.repaired)).run;
const second = spawn(process.execPath, ["dist/src/server/main.js"], {
  env: { ...process.env, PORT: "4312" },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("Second instance failed to start")),
      20000,
    );
    second.stdout.on("data", (data) => {
      if (String(data).includes("ready:")) {
        clearTimeout(t);
        resolve();
      }
    });
    second.on("exit", () => {
      clearTimeout(t);
      reject(new Error("Second instance exited"));
    });
  });
  const runs = await Promise.all(
    [0, 1, 2, 3].map(() =>
      request(`/projects/${original.project_id}/runs`, "POST", {
        environmentId: original.environment_id,
        caseId: original.case_id,
        flowId: original.flow_id,
        mode: "execute",
      }),
    ),
  );
  const deadline = Date.now() + 120000;
  let complete: any[] = [];
  while (Date.now() < deadline) {
    complete = await query(
      "SELECT id,status,worker_id FROM runs WHERE id=ANY($1::uuid[])",
      [runs.map((r) => r.id)],
    );
    if (
      complete.every((r) =>
        ["passed", "failed", "cancelled"].includes(r.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(complete.every((r) => r.status === "passed"));
  assert.equal(new Set(complete.map((r) => r.worker_id)).size, 2);
  console.log(
    "PASS two independent server instances claim distinct shared PostgreSQL tasks and finish all four replays",
  );
  const cancelled = await request(
    `/projects/${original.project_id}/runs`,
    "POST",
    {
      environmentId: original.environment_id,
      caseId: original.case_id,
      flowId: original.flow_id,
      mode: "execute",
    },
  );
  await request("/runs/" + cancelled.id + "/cancel", "POST", {});
  const cancelledState = await request("/runs/" + cancelled.id);
  assert.ok(["cancelled", "running"].includes(cancelledState.run.status));
  for (let i = 0; i < 15; i++) {
    const r = await request("/runs/" + cancelled.id);
    if (r.run.status === "cancelled") break;
    if (i === 14) assert.fail("Cancellation did not finish");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("PASS cancellation propagates through shared queue");
} finally {
  second.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    second.once("exit", () => resolve());
    setTimeout(() => {
      second.kill("SIGKILL");
      resolve();
    }, 10000).unref();
  });
  await pool.end();
}
