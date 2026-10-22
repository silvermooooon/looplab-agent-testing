import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../src/server/config.js";
import { pool, one } from "../src/server/db.js";
import { resolveSteps } from "../src/server/repository.js";
import { flowSchema } from "../src/testing/spec.js";
import { exportScript } from "../src/testing/export.js";
import { decryptSecrets } from "../src/server/security.js";
const result = JSON.parse(
  await readFile(".data/acceptance-result.json", "utf8"),
);
const run = await one(
  "SELECT r.*,e.base_url,e.secrets_encrypted,e.variables FROM runs r JOIN environments e ON e.id=r.environment_id WHERE r.id=$1",
  [result.runIds.repaired],
);
const flow = await one("SELECT * FROM flows WHERE id=$1", [run.flow_id]);
const nodes = await resolveSteps(
  run.project_id,
  run.environment_id,
  flowSchema.parse(flow.steps),
);
await writeFile(".data/exported-flow.ts", exportScript(nodes));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TEST_BASE_URL: run.base_url,
  PLAYWRIGHT_CHANNEL: config.browserChannel,
};
for (const [key, value] of Object.entries(
  decryptSecrets(run.secrets_encrypted),
))
  env["TEST_SECRET_" + key] = value;
for (const [key, value] of Object.entries(run.variables))
  env["TEST_VAR_" + key] = String(value);
const execution = await promisify(execFile)(
  process.execPath,
  ["--import", "tsx", "exported-flow.ts"],
  { cwd: ".data", env, timeout: 90000 },
);
console.log(execution.stdout.trim());
await pool.end();
console.log("Standalone exported TypeScript flow: passed");
