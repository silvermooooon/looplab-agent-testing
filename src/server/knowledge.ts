import { z } from "zod";
import { one, query } from "./db.js";

const titleLimit = 120;
const contentLimit = 60000;
const defaultDocuments = 8;
const excerptLength = 2400;
const pageLength = 10000;
const searchPageSize = 20;

export const knowledgeInput = z.object({
  title: z.string().trim().min(1).max(titleLimit),
  content: z.string().min(1).max(contentLimit),
});
export const knowledgeFields = {
  id: {
    type: "string",
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  },
  title: { type: "string", maxLength: titleLimit, pattern: "\\S" },
  content: { type: "string", maxLength: contentLimit, pattern: "\\S" },
};

export async function defaultKnowledge(projectId: string) {
  const rows = await query<{
    id: string;
    title: string;
    content: string;
    truncated: boolean;
  }>(
    `SELECT id,title,left(content,$2) content,char_length(content)>$2 truncated
     FROM knowledge WHERE project_id=$1 ORDER BY updated_at DESC,id LIMIT $3`,
    [projectId, excerptLength, defaultDocuments + 1],
  );
  const documents = rows.slice(0, defaultDocuments);
  return {
    documents,
    hasMore:
      rows.length > defaultDocuments || documents.some((doc) => doc.truncated),
  };
}

export async function searchKnowledge(
  projectId: string,
  search: string,
  offset: number,
) {
  const term = search.replace(/[\\%_]/g, "\\$&");
  const rows = await query(
    `SELECT id,title,updated_at FROM knowledge
     WHERE project_id=$1 AND (title ILIKE $2 OR content ILIKE $2)
     ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
    [projectId, `%${term}%`, searchPageSize + 1, offset],
  );
  return {
    items: rows.slice(0, searchPageSize),
    nextOffset: rows.length > searchPageSize ? offset + searchPageSize : null,
  };
}

export async function readKnowledge(
  projectId: string,
  id: string,
  offset: number,
) {
  const row = await one<{
    id: string;
    title: string;
    content: string;
    total: number;
  }>(
    `SELECT id,title,substr(content,$3::int+1,$4) content,char_length(content) total
     FROM knowledge WHERE id=$1 AND project_id=$2`,
    [id, projectId, offset, pageLength],
  );
  if (!row) throw new Error("知识文档不存在或不属于当前项目");
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    nextOffset: offset + pageLength < row.total ? offset + pageLength : null,
  };
}

export function saveKnowledge(
  projectId: string,
  { id, title, content }: z.infer<typeof knowledgeInput> & { id?: string },
) {
  if (id)
    return one(
      "UPDATE knowledge SET title=$1,content=$2,updated_at=now() WHERE id=$3 AND project_id=$4 RETURNING *",
      [title, content, id, projectId],
    );
  return one(
    "INSERT INTO knowledge(project_id,title,content) VALUES($1,$2,$3) RETURNING *",
    [projectId, title, content],
  );
}
