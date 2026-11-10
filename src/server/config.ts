import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";
import { MODEL } from "../openai/responses.js";

const dataDirOverride = process.env.LOOPLAB_DATA_DIR;
const dataDir = resolve(dataDirOverride || ".data");
const localPath = dataDirOverride
  ? resolve(dataDir, ".env.local")
  : resolve(".env.local");
const local = existsSync(localPath) ? parse(readFileSync(localPath)) : {};
const env = { ...local, ...process.env };
export const config = {
  databaseUrl: env.DATABASE_URL ?? "",
  appSecret: env.APP_SECRET ?? "",
  port: positiveInteger("PORT", env.PORT, 4310, 65535),
  host: env.HOST || "127.0.0.1",
  secureCookie: env.COOKIE_SECURE === "true",
  demoEnabled: env.DEMO_TARGET_ENABLED === "true",
  browserChannel: env.PLAYWRIGHT_CHANNEL || undefined,
  dataDir,
  personalMemoryDir: env.LOOPLAB_PERSONAL_MEMORY_DIR
    ? resolve(env.LOOPLAB_PERSONAL_MEMORY_DIR)
    : resolve(dataDir, "personal-memory"),
  gitExecutable: env.LOOPLAB_GIT_EXECUTABLE || "git",
  runTimeoutMs: positiveInteger(
    "RUN_TIMEOUT_MS",
    env.RUN_TIMEOUT_MS,
    600000,
    2147483647,
  ),
};
export function validateConfig() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
}

export const llmSettingsInput = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }),
    apiKey: z.string().trim().min(1).max(10000),
    model: z.string().trim().min(1).max(200),
  })
  .strict();

export function legacyLlmSettings() {
  const inherited =
    env.OPENAI_ENV_FILE && existsSync(env.OPENAI_ENV_FILE)
      ? parse(readFileSync(env.OPENAI_ENV_FILE))
      : {};
  return {
    baseUrl:
      env.OPENAI_BASE_URL ||
      local.OPENAI_BASE_URL ||
      inherited.OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
    apiKey:
      env.OPENAI_API_KEY ||
      local.OPENAI_API_KEY ||
      inherited.OPENAI_API_KEY ||
      "",
    model:
      env.OPENAI_MODEL || local.OPENAI_MODEL || inherited.OPENAI_MODEL || MODEL,
  };
}

function positiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  max: number,
) {
  const result = Number(value || defaultValue);
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  return result;
}
