import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  encryptSecrets,
  decryptSecrets,
  hashPassword,
  verifyPassword,
} from "../src/server/security.js";
import { config } from "../src/server/config.js";
test("redaction preserves typed fields even when credentials resemble JSON primitives", () => {
  assert.deepEqual(
    redact(
      {
        ok: true,
        count: 1,
        created: new Date("2026-10-22T00:00:00Z"),
        nested: ["true 1 secret"],
        content: "secret",
      },
      { a: "true", b: "1", c: "secret" },
    ),
    {
      ok: true,
      count: 1,
      created: "2026-10-22T00:00:00.000Z",
      nested: ["[REDACTED] [REDACTED] [REDACTED]"],
      content: "[REDACTED]",
    },
  );
});
test("credential encryption authenticates shared APP_SECRET", () => {
  const original = config.appSecret;
  try {
    config.appSecret = "test-only-long-encryption-secret-0001";
    const sealed = encryptSecrets({ password: "sample-secret" });
    assert.ok(!sealed.includes("sample-secret"));
    assert.deepEqual(decryptSecrets(sealed), { password: "sample-secret" });
    config.appSecret = "test-only-long-encryption-secret-0002";
    assert.throws(() => decryptSecrets(sealed));
  } finally {
    config.appSecret = original;
  }
});
test("password hashes use unique salts and reject incorrect passwords", () => {
  const first = hashPassword("test-password-123"),
    second = hashPassword("test-password-123");
  assert.notEqual(first, second);
  assert.equal(verifyPassword("test-password-123", first), true);
  assert.equal(verifyPassword("wrong", first), false);
});
