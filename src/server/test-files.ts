import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { one, query, transaction } from "./db.js";
import { HttpError, requireMember } from "./repository.js";

const uuid = z.string().uuid();
const maxFileSize = 10 * 1024 * 1024;
const columns =
  "id,project_id,name,mime_type,size,sha256,created_by,created_at,archived_at";
const path = (r: FastifyRequest, key: string) =>
  uuid.parse((r.params as Record<string, string>)[key]);
const uid = (r: FastifyRequest) => {
  if (!r.currentUser) throw new HttpError(401, "请先登录");
  return r.currentUser.id;
};

export async function testFileRoutes(app: FastifyInstance) {
  app.get("/api/projects/:pid/files", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const p = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        q: z.string().max(200).default(""),
        archived: z.enum(["true", "false"]).default("false"),
      })
      .parse(r.query);
    const filter =
      "project_id=$1 AND name ILIKE $2 AND (archived_at IS NOT NULL)=$3";
    const args = [pid, `%${p.q}%`, p.archived === "true"];
    const [items, total] = await Promise.all([
      query(
        `SELECT ${columns} FROM test_files WHERE ${filter} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
        [...args, p.pageSize, (p.page - 1) * p.pageSize],
      ),
      one(
        `SELECT count(*)::int AS total FROM test_files WHERE ${filter}`,
        args,
      ),
    ]);
    return { items, total: total!.total, page: p.page, pageSize: p.pageSize };
  });

  app.post(
    "/api/projects/:pid/files",
    { bodyLimit: 15 * 1024 * 1024 },
    async (r) => {
      const pid = path(r, "pid");
      const userId = uid(r);
      await requireMember(pid, userId, true);
      const input = z
        .object({
          name: z.string().trim().min(1).max(255),
          mimeType: z.string().max(255).default(""),
          data: z.string().max(Math.ceil(maxFileSize / 3) * 4),
        })
        .strict()
        .parse(r.body);
      const name = input.name.replace(/[\\/\x00-\x1f\x7f]/g, "_");
      if (name === "." || name === "..") throw new HttpError(400, "文件名无效");
      const mime = input.mimeType || "application/octet-stream";
      if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime))
        throw new HttpError(400, "文件类型无效");
      const data = Buffer.from(input.data, "base64");
      if (data.toString("base64") !== input.data)
        throw new HttpError(400, "文件内容的 Base64 编码无效");
      if (data.length > maxFileSize)
        throw new HttpError(400, "单个测试文件不能超过 10 MiB");
      const sha256 = createHash("sha256").update(data).digest("hex");
      return transaction(async (c) => {
        const project = (
          await c.query(
            "SELECT archived_at FROM projects WHERE id=$1 FOR SHARE",
            [pid],
          )
        ).rows[0];
        if (!project) throw new HttpError(404, "项目不存在");
        if (project.archived_at)
          throw new HttpError(409, "项目已归档，请先恢复项目");
        return (
          await c.query(
            `INSERT INTO test_files(project_id,name,mime_type,size,sha256,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
            [pid, name, mime, data.length, sha256, data, userId],
          )
        ).rows[0];
      });
    },
  );

  app.get("/api/projects/:pid/files/:fid", async (r) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const file = await one(
      `SELECT ${columns} FROM test_files WHERE id=$1 AND project_id=$2`,
      [path(r, "fid"), pid],
    );
    if (!file) throw new HttpError(404, "测试文件不存在");
    return file;
  });

  app.patch("/api/projects/:pid/files/:fid", async (r) => {
    const pid = path(r, "pid"),
      fid = path(r, "fid");
    await requireMember(pid, uid(r), true);
    const { archived } = z
      .object({ archived: z.boolean() })
      .strict()
      .parse(r.body);
    const file = await one(
      `UPDATE test_files SET archived_at=CASE WHEN $3 THEN COALESCE(archived_at,now()) ELSE NULL END WHERE id=$1 AND project_id=$2 RETURNING ${columns}`,
      [fid, pid, archived],
    );
    if (!file) throw new HttpError(404, "测试文件不存在");
    return file;
  });

  app.get("/api/projects/:pid/files/:fid/download", async (r, reply) => {
    const pid = path(r, "pid");
    await requireMember(pid, uid(r));
    const file = await one(
      "SELECT name,mime_type,data FROM test_files WHERE id=$1 AND project_id=$2",
      [path(r, "fid"), pid],
    );
    if (!file) throw new HttpError(404, "测试文件不存在");
    return reply
      .type(file.mime_type)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .send(file.data);
  });
}
