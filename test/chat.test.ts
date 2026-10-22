import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAttachment,
  attachmentContent,
  safeStreamPrefix,
  MAX_ATTACHMENT_BYTES,
} from "../src/server/chat-files.js";
import { redact } from "../src/server/security.js";
import { responseInput } from "../src/openai/responses.js";
const encode = (s: string) => Buffer.from(s).toString("base64");
test("uploaded test files are UTF-8 data; reject disguised binaries, active SVG and oversized payloads", () => {
  const result = validateAttachment("../测试.md", encode("检查登录\n检查回复"));
  assert.equal(result.filename, "测试.md");
  assert.equal(result.mime, "text/plain");
  for (const [name, data] of [
    ["x.png", encode("not a png")],
    ["x.svg", encode("<svg/>")],
    ["x.txt", Buffer.from([0xff]).toString("base64")],
    ["x.md", encode("\0binary")],
    ["x.txt", "invalid!"],
    ["x.txt", Buffer.alloc(200001, 65).toString("base64")],
    ["x.pdf", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")],
  ])
    assert.throws(() => validateAttachment(name!, data!));
});
test("Responses input carries screenshot and PDF contents, not filenames alone", () => {
  const image = attachmentContent({
    name: "page.png",
    mime_type: "image/png",
    data: Buffer.from("pixels"),
  });
  const pdf = attachmentContent({
    name: "test.pdf",
    mime_type: "application/pdf",
    data: Buffer.from("%PDF-example"),
  });
  const input = responseInput([
    {
      role: "user",
      content: [{ type: "text", text: "请阅读" }, image, pdf],
      timestamp: 0,
    },
  ]) as any[];
  assert.equal(input[0].content[1].type, "input_image");
  assert.match(input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.deepEqual(input[0].content[2], {
    type: "input_file",
    filename: "test.pdf",
    file_data: "data:application/pdf;base64," + encode("%PDF-example"),
  });
});
test("streamed credential fragments are withheld until full redaction is possible", () => {
  const secrets = { password: "secret-password-123", key: "key-abcd" };
  for (const key of Object.values(secrets))
    for (let i = 1; i < key.length; i++)
      assert.equal(
        safeStreamPrefix("answer " + key.slice(0, i), secrets),
        "answer ",
      );
  assert.equal(safeStreamPrefix("normal answer", secrets), "normal answer");
  const safe = redact(
    safeStreamPrefix("answer secret-password-123!", secrets),
    secrets,
  ) as string;
  assert.equal(safe.includes(secrets.password), false);
  assert.match(safe, /\[REDACTED\]/);
});
