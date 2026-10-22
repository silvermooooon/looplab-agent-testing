import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import { resolve } from "node:path";

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
  apiKey: env.OPENAI_API_KEY || inherited.OPENAI_API_KEY || "",
  baseUrl:
    env.OPENAI_BASE_URL ||
    inherited.OPENAI_BASE_URL ||
    "https://api.openai.com/v1",
  port: Number(env.PORT || 4310),
  host: env.HOST || "127.0.0.1",
  secureCookie: env.COOKIE_SECURE === "true",
  demoEnabled: env.DEMO_TARGET_ENABLED === "true",
  browserChannel: env.PLAYWRIGHT_CHANNEL || undefined,
  runTimeoutMs: Number(env.RUN_TIMEOUT_MS || 600000),
};
export function validateConfig() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (config.appSecret.length < 32)
    throw new Error("APP_SECRET must contain at least 32 characters");
  if (!config.apiKey)
    throw new Error("OPENAI_API_KEY or OPENAI_ENV_FILE is required");
  const url = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid OPENAI_BASE_URL");
}
