import { readFileSync } from "node:fs";
import { legacyLlmSettings, llmSettingsInput } from "../src/server/config.js";
import { pool, prepareDatabase } from "../src/server/db.js";
import { saveLlmSettings } from "../src/server/platform-settings.js";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--from-env"))
    throw new Error("usage");
  const input =
    args[0] === "--from-env"
      ? legacyLlmSettings()
      : JSON.parse(readFileSync(0, "utf8"));
  const settings = llmSettingsInput.parse(input);
  await prepareDatabase();
  console.log(JSON.stringify(await saveLlmSettings(settings)));
} catch {
  console.error(
    "LLM 配置写入失败。请通过标准输入提供包含 baseUrl、apiKey、model 的 JSON，或使用 --from-env 导入；并确认连接具有数据库维护权限。",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
