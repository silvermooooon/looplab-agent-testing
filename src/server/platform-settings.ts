import { z } from "zod";
import { llmSettingsInput } from "./config.js";
import { one } from "./db.js";
import { HttpError } from "./repository.js";

export type LlmSettingsInput = z.infer<typeof llmSettingsInput>;

export async function getLlmSettings(): Promise<
  LlmSettingsInput & { revision: number }
> {
  const row = await one<{
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
    revision: number;
  }>(
    `SELECT llm_base_url AS "baseUrl",llm_api_key AS "apiKey",llm_model AS model,llm_revision AS revision
     FROM qa.runtime_settings WHERE id=1`,
  );
  if (!row || row.apiKey === null)
    throw new HttpError(503, "共享数据库尚未配置 LLM，请联系数据库管理员");
  const { revision, ...input } = row;
  const parsed = llmSettingsInput.safeParse(input);
  if (!parsed.success)
    throw new HttpError(503, "共享数据库的 LLM 配置无效，请联系数据库管理员");
  return { ...parsed.data, revision };
}

export async function getLlmStatus() {
  const row = await one<{ model: string | null; revision: number }>(
    "SELECT llm_model AS model,llm_revision AS revision FROM qa.runtime_settings WHERE id=1",
  );
  return {
    model: row?.model ?? "",
    configured: !!row?.model,
    revision: row?.revision ?? 0,
  };
}

export async function getLlmApiKey() {
  const row = await one<{ llm_api_key: string | null }>(
    "SELECT llm_api_key FROM qa.runtime_settings WHERE id=1",
  );
  return row?.llm_api_key?.trim() ?? "";
}

export async function saveLlmSettings({
  baseUrl,
  apiKey,
  model,
}: LlmSettingsInput) {
  const row = await one<{ model: string; revision: number }>(
    `UPDATE qa.runtime_settings
     SET llm_base_url=$1,llm_api_key=$2,llm_model=$3,
         llm_revision=llm_revision+1,llm_updated_at=now()
     WHERE id=1 RETURNING llm_model AS model,llm_revision AS revision`,
    [baseUrl, apiKey, model],
  );
  if (!row) throw new HttpError(503, "共享数据库缺少运行配置，请先初始化");
  return { ...row, configured: true };
}
