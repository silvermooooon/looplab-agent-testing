import type { PoolClient } from "pg";

export async function migrateJira(c: PoolClient) {
  if (
    (await c.query("SELECT 1 FROM qa.schema_migrations WHERE version=10"))
      .rowCount
  )
    return;
  await c.query(`
    CREATE TABLE jira_issues(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id),origin text NOT NULL,url text NOT NULL,issue_key text NOT NULL,title text NOT NULL,description text NOT NULL,acceptance text NOT NULL DEFAULT '',comments text NOT NULL DEFAULT '',status text NOT NULL DEFAULT '',fetched_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,origin,issue_key));
    CREATE INDEX jira_issues_project_idx ON jira_issues(project_id,fetched_at DESC);
    CREATE TABLE jira_adapters(project_id uuid NOT NULL REFERENCES projects(id),origin text NOT NULL,revision integer NOT NULL DEFAULT 1,script jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,origin));
    CREATE TABLE jira_adapter_versions(project_id uuid NOT NULL REFERENCES projects(id),origin text NOT NULL,revision integer NOT NULL,script jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,origin,revision));
    CREATE TABLE jira_publications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id),issue_id uuid NOT NULL REFERENCES jira_issues(id),run_id uuid REFERENCES runs(id),operation text NOT NULL,status text NOT NULL,summary text NOT NULL,marker text,requested_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX jira_publications_issue_idx ON jira_publications(issue_id,created_at DESC);
    ALTER TABLE test_cases ADD CONSTRAINT test_cases_jira_issue_fk FOREIGN KEY(jira_issue_id) REFERENCES jira_issues(id);
    ALTER TABLE runs ADD COLUMN executor_id text;
    ALTER TABLE runs ADD COLUMN parent_run_id uuid REFERENCES runs(id);
    INSERT INTO qa.schema_migrations(version) VALUES(10);
  `);
}
