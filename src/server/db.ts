import pg from "pg";
import { config } from "./config.js";
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 12,
  options: "-c search_path=qa,public",
});
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
export async function one<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate() {
  await transaction(async (c) => {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('agent-test-platform:migrations'))",
    );
    await c.query(`
      CREATE SCHEMA IF NOT EXISTS qa;
      CREATE TABLE IF NOT EXISTS qa.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    `);
    const exists = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=1",
    );
    if (!exists.rowCount) {
      await c.query(`
      CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE TABLE projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE members(project_id uuid REFERENCES projects(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(project_id,user_id));
      CREATE TABLE environments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL, base_url text NOT NULL, variables jsonb NOT NULL DEFAULT '{}', secrets_encrypted text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,name));
      CREATE TABLE knowledge(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, content text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE test_cases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, instructions text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE nodes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,key));
      CREATE TABLE node_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, environment_id uuid NOT NULL REFERENCES environments(id), version integer NOT NULL, spec jsonb NOT NULL, source text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(node_id,environment_id,version));
      CREATE TABLE flows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id), environment_id uuid NOT NULL REFERENCES environments(id), case_id uuid NOT NULL REFERENCES test_cases(id), name text NOT NULL, steps jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id), environment_id uuid NOT NULL REFERENCES environments(id), case_id uuid NOT NULL REFERENCES test_cases(id), flow_id uuid REFERENCES flows(id), repair_node_id uuid REFERENCES nodes(id), mode text NOT NULL CHECK(mode IN ('generate','execute','repair')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','passed','failed','cancelled')), requested_by uuid NOT NULL REFERENCES users(id), summary text NOT NULL DEFAULT '', error text, snapshot jsonb, worker_id text, cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, heartbeat_at timestamptz);
      CREATE INDEX runs_queue_idx ON runs(created_at) WHERE status='queued';
      CREATE INDEX runs_project_idx ON runs(project_id,created_at DESC);
      CREATE TABLE run_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, kind text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX run_events_run_idx ON run_events(run_id,id);
      CREATE TABLE artifacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, name text NOT NULL, mime_type text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO qa.schema_migrations(version) VALUES(1);
    `);
    }
    const v2 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=2",
    );
    if (!v2.rowCount)
      await c.query(`
      ALTER TABLE projects ADD COLUMN archived_at timestamptz;
      ALTER TABLE environments ADD COLUMN archived_at timestamptz;
      CREATE INDEX members_user_idx ON members(user_id,project_id);
      CREATE INDEX cases_project_idx ON test_cases(project_id,created_at DESC);
      CREATE INDEX knowledge_project_idx ON knowledge(project_id,updated_at DESC);
      CREATE INDEX flows_environment_idx ON flows(project_id,environment_id,created_at DESC);
      CREATE INDEX runs_environment_idx ON runs(project_id,environment_id,created_at DESC);
      CREATE INDEX artifacts_run_idx ON artifacts(run_id,created_at);
      INSERT INTO qa.schema_migrations(version) VALUES(2);
    `);
  });
}
