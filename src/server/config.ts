import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import { resolve } from "node:path";
import { MODEL } from "../openai/responses.js";

const localPath = resolve(".env.local");
const local = existsSync(localPath) ? parse(readFileSync(localPath)) : {};
const env = { ...local, ...process.env };
const inherited =
  env.OPENAI_ENV_FILE && existsSync(env.OPENAI_ENV_FILE)
    ? parse(readFileSync(env.OPENAI_ENV_FILE))
    : {};
export const config = {
  databaseUrl: env.DATABASE_URL ?? "",
  appSecret: env.APP_SECRET ?? "",
  apiKey:
    process.env.OPENAI_API_KEY ||
    local.OPENAI_API_KEY ||
    inherited.OPENAI_API_KEY ||
    "",
  baseUrl:
    process.env.OPENAI_BASE_URL ||
    local.OPENAI_BASE_URL ||
    inherited.OPENAI_BASE_URL ||
    "https://api.openai.com/v1",
  model:
    process.env.OPENAI_MODEL ||
    local.OPENAI_MODEL ||
    inherited.OPENAI_MODEL ||
    MODEL,
  port: positiveInteger("PORT", env.PORT, 4310, 65535),
  host: env.HOST || "127.0.0.1",
  secureCookie: env.COOKIE_SECURE === "true",
  demoEnabled: env.DEMO_TARGET_ENABLED === "true",
  browserChannel: env.PLAYWRIGHT_CHANNEL || undefined,
  runTimeoutMs: positiveInteger(
    "RUN_TIMEOUT_MS",
    env.RUN_TIMEOUT_MS,
    600000,
    2147483647,
  ),
};
export function validateConfig() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (config.appSecret.length < 32)
    throw new Error("APP_SECRET must contain at least 32 characters");
  if (!config.apiKey)
    throw new Error("OPENAI_API_KEY or OPENAI_ENV_FILE is required");
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("Invalid OPENAI_BASE_URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid OPENAI_BASE_URL");
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
