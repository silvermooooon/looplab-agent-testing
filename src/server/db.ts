import pg from "pg";
import { randomBytes } from "node:crypto";
import {
  config,
  legacyLlmSettings,
  llmSettingsInput,
  validateConfig,
} from "./config.js";
import { migrateJira } from "./jira-db.js";
import { decryptSecrets } from "./security.js";

const schemaVersion = 11;
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
  validateConfig();
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
    const v3 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=3",
    );
    if (!v3.rowCount)
      await c.query(`
      ALTER TABLE test_cases ADD COLUMN is_draft boolean NOT NULL DEFAULT false;
      CREATE TABLE chat_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id),environment_id uuid NOT NULL REFERENCES environments(id),case_id uuid NOT NULL REFERENCES test_cases(id),repair_node_id uuid REFERENCES nodes(id),title text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX chat_sessions_project_idx ON chat_sessions(project_id,environment_id,updated_at DESC);
      ALTER TABLE runs ADD COLUMN conversation_id uuid REFERENCES chat_sessions(id);
      ALTER TABLE runs ADD COLUMN events_complete boolean NOT NULL DEFAULT false;
      UPDATE runs SET events_complete=true WHERE status NOT IN ('queued','running');
      ALTER TABLE runs DROP CONSTRAINT runs_status_check;
      ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK(status IN ('queued','running','passed','failed','cancelled','completed'));
      CREATE INDEX runs_conversation_idx ON runs(conversation_id,created_at DESC) WHERE conversation_id IS NOT NULL;
      CREATE UNIQUE INDEX chat_one_active_run ON runs(conversation_id) WHERE conversation_id IS NOT NULL AND status IN ('queued','running');
      CREATE TABLE chat_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,conversation_id uuid NOT NULL REFERENCES chat_sessions(id),role text NOT NULL CHECK(role IN ('user','assistant')),content text NOT NULL DEFAULT '',run_id uuid NOT NULL REFERENCES runs(id),author_id uuid REFERENCES users(id),client_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,role),UNIQUE(conversation_id,author_id,client_id));
      CREATE INDEX chat_messages_session_idx ON chat_messages(conversation_id,seq);
      CREATE TABLE chat_attachments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL REFERENCES chat_sessions(id),message_id uuid REFERENCES chat_messages(id),created_by uuid NOT NULL REFERENCES users(id),name text NOT NULL,mime_type text NOT NULL,size integer NOT NULL,data bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX chat_attachments_session_idx ON chat_attachments(conversation_id,message_id);
      INSERT INTO qa.schema_migrations(version) VALUES(3);
    `);
    const v4 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=4",
    );
    if (!v4.rowCount)
      await c.query(`
      ALTER TABLE flows ADD COLUMN category text NOT NULL DEFAULT 'feature' CHECK(category IN ('health','full','feature','one_off','regression'));
      CREATE TABLE test_suites(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id),environment_id uuid NOT NULL REFERENCES environments(id),name text NOT NULL,description text NOT NULL DEFAULT '',flow_ids uuid[] NOT NULL DEFAULT '{}',created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX test_suites_environment_idx ON test_suites(project_id,environment_id,updated_at DESC);
      CREATE TABLE suite_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),suite_id uuid REFERENCES test_suites(id) ON DELETE SET NULL,project_id uuid NOT NULL REFERENCES projects(id),environment_id uuid NOT NULL REFERENCES environments(id),suite_name text NOT NULL,requested_by uuid NOT NULL REFERENCES users(id),cancel_requested boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX suite_runs_environment_idx ON suite_runs(project_id,environment_id,created_at DESC);
      ALTER TABLE runs ADD COLUMN suite_run_id uuid REFERENCES suite_runs(id);
      ALTER TABLE runs ADD COLUMN suite_position integer;
      ALTER TABLE runs ADD COLUMN suite_flow_name text;
      ALTER TABLE runs ADD COLUMN suite_case_title text;
      CREATE UNIQUE INDEX runs_suite_position_idx ON runs(suite_run_id,suite_position) WHERE suite_run_id IS NOT NULL;
      INSERT INTO qa.schema_migrations(version) VALUES(4);
    `);
    const v5 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=5",
    );
    if (!v5.rowCount)
      await c.query(`
      CREATE TABLE run_interventions(run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,info jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE intervention_commands(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),seq bigint GENERATED ALWAYS AS IDENTITY,run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,action jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',error text,data bytea,created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX intervention_commands_pending_idx ON intervention_commands(run_id,seq) WHERE status='pending';
      INSERT INTO qa.schema_migrations(version) VALUES(5);
    `);
    const v6 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=6",
    );
    if (!v6.rowCount)
      await c.query(`
      CREATE TABLE test_files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id),name text NOT NULL,mime_type text NOT NULL,size integer NOT NULL,sha256 text NOT NULL,data bytea NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
      CREATE INDEX test_files_project_idx ON test_files(project_id,created_at DESC,id);
      INSERT INTO qa.schema_migrations(version) VALUES(6);
    `);
    const v7 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=7",
    );
    if (!v7.rowCount)
      await c.query(`
      CREATE TABLE chat_message_test_files(message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,file_id uuid NOT NULL REFERENCES test_files(id),position integer NOT NULL,PRIMARY KEY(message_id,file_id),UNIQUE(message_id,position));
      INSERT INTO qa.schema_migrations(version) VALUES(7);
    `);
    const v8 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=8",
    );
    if (!v8.rowCount)
      await c.query(`
      CREATE TABLE run_previews(run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,requested_at timestamptz NOT NULL DEFAULT now(),state text NOT NULL DEFAULT 'waiting',frame_id text,meta jsonb,data bytea);
      INSERT INTO qa.schema_migrations(version) VALUES(8);
    `);
    const v9 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=9",
    );
    if (!v9.rowCount)
      await c.query(`
      ALTER TABLE test_cases ADD COLUMN version integer NOT NULL DEFAULT 1;
      ALTER TABLE test_cases ADD COLUMN jira_issue_id uuid;
      CREATE TABLE test_case_versions(case_id uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,version integer NOT NULL,title text NOT NULL,instructions text NOT NULL,jira_issue_id uuid,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(case_id,version));
      INSERT INTO test_case_versions(case_id,version,title,instructions,created_at) SELECT id,version,title,instructions,created_at FROM test_cases;
      ALTER TABLE flows ADD COLUMN case_version integer;
      INSERT INTO qa.schema_migrations(version) VALUES(9);
    `);
    await migrateJira(c);
    const v11 = await c.query(
      "SELECT 1 FROM qa.schema_migrations WHERE version=11",
    );
    if (!v11.rowCount) {
      const existing = (
        await c.query("SELECT secrets_encrypted FROM environments LIMIT 1")
      ).rows[0];
      const appSecret = config.appSecret || randomBytes(32).toString("hex");
      if (appSecret.length < 32)
        throw new Error("初始化共享应用密钥需要至少 32 字符的 APP_SECRET");
      if (existing) {
        if (!config.appSecret)
          throw new Error("升级已有环境凭据的数据库需要原 APP_SECRET");
        try {
          decryptSecrets(existing.secrets_encrypted);
        } catch {
          throw new Error("原 APP_SECRET 无法解密已有环境凭据，已停止迁移");
        }
      }
      const local = legacyLlmSettings();
      const settings = local.apiKey
        ? llmSettingsInput.safeParse(local)
        : undefined;
      if (settings && !settings.success)
        throw new Error("原 LLM 配置格式不正确，请核对后重新初始化");
      await c.query(`
        CREATE TABLE qa.runtime_settings(
          id smallint PRIMARY KEY CHECK(id=1),
          app_secret text NOT NULL CHECK(char_length(app_secret)>=32),
          llm_base_url text,
          llm_api_key text,
          llm_model text,
          llm_revision integer NOT NULL DEFAULT 0,
          llm_updated_at timestamptz,
          CHECK(num_nonnulls(llm_base_url,llm_api_key,llm_model) IN (0,3))
        );
      `);
      const initial = settings?.data;
      await c.query(
        `INSERT INTO qa.runtime_settings
        (id,app_secret,llm_base_url,llm_api_key,llm_model,llm_revision,llm_updated_at)
        VALUES(1,$1,$2,$3,$4,$5,CASE WHEN $5=0 THEN NULL ELSE now() END)`,
        [
          appSecret,
          initial?.baseUrl ?? null,
          initial?.apiKey ?? null,
          initial?.model ?? null,
          initial ? 1 : 0,
        ],
      );
      await c.query("INSERT INTO qa.schema_migrations(version) VALUES(11)");
    }
  });
}

export async function prepareDatabase() {
  validateConfig();
  const schema = await one<{ version: number | null }>(
    "SELECT max(version) AS version FROM qa.schema_migrations",
  ).catch((error: { code?: string }) => {
    if (error.code === "42P01" || error.code === "3F000") return undefined;
    throw error;
  });
  const version = schema?.version ?? 0;
  if (version > schemaVersion)
    throw new Error("数据库 schema 版本高于当前服务，请更新分发包");
  if (version < schemaVersion) await migrate();
  const runtime = await one<{ app_secret: string }>(
    "SELECT app_secret FROM qa.runtime_settings WHERE id=1",
  );
  if (!runtime) throw new Error("共享数据库缺少运行配置，请联系数据库管理员");
  config.appSecret = runtime.app_secret;
}
