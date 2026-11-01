import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Explicit local bootstrap. Never replace an existing configuration or database.
if (existsSync(".env.local"))
  throw new Error(".env.local already exists; not overwriting it.");
const container = process.argv[2];
if (!container)
  throw new Error("Usage: npm run setup:local -- <postgres-container-name>");
const password = randomBytes(24).toString("hex");
try {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1',
    ],
    {
      input: `CREATE ROLE looplab LOGIN PASSWORD '${password}';\nCREATE DATABASE looplab OWNER looplab;\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
} catch {
  throw new Error(
    "Database creation failed. Check whether looplab already exists; no existing objects were deleted.",
  );
}
writeFileSync(
  ".env.local",
  readFileSync(".env.example", "utf8")
    .replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgresql://looplab:${password}@127.0.0.1:5432/looplab`,
    )
    .replace(
      /^APP_SECRET=.*$/m,
      `APP_SECRET=${randomBytes(32).toString("hex")}`,
    ),
  { mode: 0o600 },
);
console.log(
  "Created looplab database and local configuration. Configure the OpenAI key or OPENAI_ENV_FILE before starting.",
);
