import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantFromResponse,
  responseInput,
  MODEL,
} from "../src/openai/responses.js";
import { interpolate, specSchema } from "../src/testing/spec.js";

test("only GPT 6 Luna is selected and raw reasoning items are preserved for Responses replay", () => {
  assert.equal(MODEL, "gpt-6-luna");
  const output: any[] = [
    {
      type: "reasoning",
      id: "rs_one",
      summary: [],
      encrypted_content: "encrypted-test",
    },
    {
      type: "function_call",
      call_id: "call_one",
      name: "inspect",
      arguments: "{}",
      id: "fc_one",
      status: "completed",
    },
  ];
  const assistant = assistantFromResponse({
    output,
    status: "completed",
    error: null,
    incomplete_details: null,
  });
  assert.equal(assistant.stopReason, "toolUse");
  const input = responseInput([
    assistant,
    {
      role: "toolResult",
      toolCallId: "call_one",
      toolName: "inspect",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
  ]);
  assert.deepEqual(input.slice(0, 2), output);
  assert.equal((input[2] as any).call_id, "call_one");
});
test("incomplete Responses output never emits executable tool calls", () => {
  const message = assistantFromResponse({
    status: "incomplete",
    error: null,
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "function_call",
        call_id: "a",
        name: "click",
        arguments: '{"selector":"x"}',
        id: "fc_a",
        status: "incomplete",
      },
    ],
  });
  assert.equal(message.stopReason, "error");
  assert.equal(
    message.content.some((c) => c.type === "toolCall"),
    false,
  );
});
test("malformed Responses tool arguments fail closed", () => {
  assert.throws(() =>
    assistantFromResponse({
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [
        {
          type: "function_call",
          call_id: "a",
          name: "click",
          arguments: "{",
          id: "fc_a",
          status: "completed",
        },
      ],
    }),
  );
});
test("template resolver distinguishes params, outputs, and secret references", () => {
  const variables = {
    baseUrl: "https://example.com",
    param: { text: "hello" },
    secret: { password: "hidden" },
    var: { tenant: "qa" },
    output: { session: "123" },
  };
  assert.equal(
    interpolate(
      "{{param.text}} {{secret.password}} {{output.session}}",
      variables,
    ),
    "hello hidden 123",
  );
  assert.throws(() => interpolate("{{param.missing}}", variables), /Missing/);
  assert.throws(
    () => interpolate("{{secret.constructor}}", variables),
    /Missing/,
  );
  assert.throws(
    () => interpolate("{{secret.password.extra}}", variables),
    /Unknown/,
  );
});
test("node specs reject arbitrary code and unsupported step fields", () => {
  assert.equal(
    specSchema.safeParse({
      inputs: [],
      steps: [{ action: "eval", code: "process.exit()" }],
    }).success,
    false,
  );
  assert.equal(
    specSchema.safeParse({
      inputs: [],
      steps: [{ action: "click", selector: "#button", code: "unsafe" }],
    }).success,
    false,
  );
  assert.equal(
    specSchema.safeParse({
      inputs: [],
      steps: [{ action: "assertText", selector: "#result", text: "expected" }],
    }).success,
    true,
  );
});
