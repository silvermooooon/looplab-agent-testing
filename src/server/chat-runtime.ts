import { one, query, transaction } from "./db.js";
import { attachmentContent, safeStreamPrefix } from "./chat-files.js";
import { redact } from "./security.js";
import type { AgentMessage, Content } from "../runtime/index.js";
export async function chatHistory(run: any, secrets: Record<string, string>) {
  const current = await one(
    "SELECT seq FROM chat_messages WHERE run_id=$1 AND role='user'",
    [run.id],
  );
  const rows = await query(
    "SELECT role,content,id,created_at FROM chat_messages WHERE conversation_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 40",
    [run.conversation_id, current!.seq],
  );
  const result: AgentMessage[] = [];
  let textBudget = 120000,
    binaryBudget = 12 * 1024 * 1024,
    omitted = false;
  for (const row of rows) {
    const text = row.content.slice(0, Math.max(0, textBudget));
    textBudget -= text.length;
    const content: Content[] = [
      { type: "text", text: redact(text, secrets) as string },
    ];
    if (text.length < row.content.length) omitted = true;
    if (row.role === "user") {
      const files = await query(
        "SELECT id,name,mime_type,data,size FROM chat_attachments WHERE message_id=$1 ORDER BY created_at",
        [row.id],
      );
      for (const file of files) {
        const block = attachmentContent(file);
        if (block.type === "text") {
          const excerpt = block.text.slice(
            0,
            Math.min(40000, Math.max(0, textBudget)),
          );
          textBudget -= excerpt.length;
          content.push({
            type: "text",
            text: redact(
              `附件 ID: ${file.id}\n${excerpt}${excerpt.length < block.text.length ? "\n[附件已节选，请用 read_attachment 分页读取剩余内容]" : ""}`,
              secrets,
            ) as string,
          });
        } else if (file.size <= binaryBudget) {
          binaryBudget -= file.size;
          content.push({ type: "text", text: `附件：${file.name}` }, block);
        } else {
          content.push({
            type: "text",
            text: `较早附件 ${file.name} 未重复送入当前上下文，请让用户重新提供需要比较的图片或 PDF。`,
          });
          omitted = true;
        }
      }
      result.push({
        role: "user",
        content,
        timestamp: new Date(row.created_at).getTime(),
      });
    } else if (text)
      result.push({
        role: "assistant",
        content,
        timestamp: new Date(row.created_at).getTime(),
        stopReason: "stop",
      });
  }
  result.reverse();
  return { messages: result, omitted: omitted || rows.length === 40 };
}
export function chatWriter(run: any, secrets: Record<string, string>) {
  let committed = "",
    current = "",
    lastFlush = 0,
    lastWritten = "";
  async function flush(final = false) {
    if (!run.conversation_id) return;
    const raw = committed + current;
    const text = redact(
      final ? raw : safeStreamPrefix(raw, secrets),
      secrets,
    ) as string;
    if (text === lastWritten) return;
    await transaction(async (c) => {
      await c.query(
        "UPDATE chat_messages SET content=$1 WHERE run_id=$2 AND role='assistant'",
        [text, run.id],
      );
      await c.query(
        "INSERT INTO run_events(run_id,kind,data) VALUES($1,'agent_text',$2)",
        [run.id, JSON.stringify({ text })],
      );
    });
    lastWritten = text;
    lastFlush = Date.now();
  }
  return {
    async delta(text: string) {
      current += text;
      if (Date.now() - lastFlush >= 150) await flush();
    },
    async end(text: string) {
      current = text;
      committed += current + (current ? "\n\n" : "");
      current = "";
      await flush(true);
    },
    async append(text: string) {
      committed += current + (current ? "\n\n" : "") + text;
      current = "";
      await flush(true);
    },
    async finish() {
      await flush(true);
    },
  };
}
