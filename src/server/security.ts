import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { config } from "./config.js";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const key = () => createHash("sha256").update(config.appSecret).digest();
export function encryptSecrets(value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function decryptSecrets(value: string): Record<string, string> {
  const [iv, tag, data] = value.split(".").map((x) => Buffer.from(x, "base64"));
  if (!iv || !tag || !data) throw new Error("Invalid encrypted configuration");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
  );
}
export function redact(value: unknown, secrets: Record<string, string>): any {
  const values = Object.values(secrets)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const visit = (current: unknown): unknown => {
    if (typeof current === "string")
      return values.reduce(
        (text, secret) => text.split(secret).join("[REDACTED]"),
        current,
      );
    if (current instanceof Date) return current.toISOString();
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object")
      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [key, visit(item)]),
      );
    return current;
  };
  return visit(value);
}
