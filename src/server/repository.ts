import { query, one, transaction } from "./db.js";
import { isDeepStrictEqual } from "node:util";
import {
  nodeSource,
  specSchema,
  flowSchema,
  type NodeSpec,
  type FlowStep,
} from "../testing/spec.js";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function requireMember(
  projectId: string,
  userId: string,
  edit = false,
  owner = false,
) {
  const member = await one(
    "SELECT role FROM members WHERE project_id=$1 AND user_id=$2",
    [projectId, userId],
  );
  if (
    !member ||
    (edit && member.role === "viewer") ||
    (owner && member.role !== "owner")
  )
    throw new HttpError(403, "没有此项目的操作权限");
  return member.role as string;
}
export async function environment(projectId: string, environmentId: string) {
  const env = await one(
    "SELECT * FROM environments WHERE id=$1 AND project_id=$2",
    [environmentId, projectId],
  );
  if (!env) throw new HttpError(404, "环境不存在");
  return env;
}
export async function latestNodes(projectId: string, environmentId: string) {
  return query(
    `SELECT DISTINCT ON(n.id) n.id AS node_id,n.key,n.name,n.description,v.id AS revision_id,v.version,v.spec,v.source,v.created_at
    FROM nodes n JOIN node_versions v ON v.node_id=n.id WHERE n.project_id=$1 AND v.environment_id=$2 ORDER BY n.id,v.version DESC`,
    [projectId, environmentId],
  );
}
export async function saveNode(
  projectId: string,
  envId: string,
  userId: string,
  input: { key: string; name: string; description: string; spec: NodeSpec },
) {
  const spec = specSchema.parse(input.spec);
  await environment(projectId, envId);
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${projectId}:${input.key}:${envId}`,
    ]);
    const node = (
      await c.query(
        `INSERT INTO nodes(project_id,key,name,description) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id,key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description RETURNING *`,
        [projectId, input.key, input.name, input.description],
      )
    ).rows[0];
    const previous = (
      await c.query(
        "SELECT * FROM node_versions WHERE node_id=$1 AND environment_id=$2 ORDER BY version DESC LIMIT 1",
        [node.id, envId],
      )
    ).rows[0];
    if (previous && isDeepStrictEqual(previous.spec, spec))
      return {
        nodeId: node.id,
        revisionId: previous.id,
        version: previous.version,
        reused: true,
      };
    const revision = (
      await c.query(
        "INSERT INTO node_versions(node_id,environment_id,version,spec,source,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version",
        [
          node.id,
          envId,
          (previous?.version ?? 0) + 1,
          JSON.stringify(spec),
          nodeSource(input.key, spec),
          userId,
        ],
      )
    ).rows[0];
    return {
      nodeId: node.id,
      revisionId: revision.id,
      version: revision.version,
      reused: false,
    };
  });
}
export async function resolveSteps(
  projectId: string,
  envId: string,
  steps: FlowStep[],
) {
  const parsed = flowSchema.parse(steps);
  const result = [];
  for (const step of parsed) {
    const revision = await one(
      `SELECT v.*,n.name,n.key,n.project_id FROM node_versions v JOIN nodes n ON n.id=v.node_id
      WHERE v.id=$1 AND n.project_id=$2 AND v.environment_id=$3`,
      [step.revisionId, projectId, envId],
    );
    if (!revision)
      throw new HttpError(400, "流程包含不属于此项目或环境的节点版本");
    const spec = specSchema.parse(revision.spec);
    for (const key of spec.inputs)
      if (!Object.hasOwn(step.params, key))
        throw new HttpError(400, `缺少节点参数 ${key}`);
    result.push({ ...revision, params: step.params });
  }
  return result;
}
export async function saveFlow(
  projectId: string,
  envId: string,
  caseId: string,
  userId: string,
  name: string,
  steps: FlowStep[],
) {
  await resolveSteps(projectId, envId, steps);
  if (
    !(await one("SELECT id FROM test_cases WHERE id=$1 AND project_id=$2", [
      caseId,
      projectId,
    ]))
  )
    throw new HttpError(404, "测试用例不存在");
  return one(
    "INSERT INTO flows(project_id,environment_id,case_id,name,steps,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [projectId, envId, caseId, name, JSON.stringify(steps), userId],
  );
}
