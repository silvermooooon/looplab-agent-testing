import { Agent } from "../src/runtime/index.js";
import { createResponsesStream } from "../src/openai/responses.js";
import { pool, prepareDatabase } from "../src/server/db.js";
import { getLlmSettings } from "../src/server/platform-settings.js";

const { baseUrl, apiKey, model, revision } = await prepareDatabase()
  .then(() => getLlmSettings())
  .finally(() => pool.end());
const agent = new Agent({
  streamFn: createResponsesStream({
    apiKey,
    baseURL: baseUrl,
    model,
  }),
  maxTurns: 5,
  systemPrompt:
    'Call the echo tool once with value "responses-ready", then report the tool result.',
  tools: [
    {
      name: "echo",
      description: "Echo a value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      async execute(_id, args: any) {
        return { content: [{ type: "text", text: args.value }] };
      },
    },
  ],
});
await agent.prompt("Verify the real Responses API tool loop.");
if (
  agent.state.lastEndReason !== "completed" ||
  !agent.state.messages.some((m) => m.role === "toolResult")
)
  throw new Error(
    `Live model check failed: ${String(agent.state.errorMessage ?? agent.state.lastEndReason).replaceAll(apiKey, "[REDACTED]")}`,
  );
console.log(
  JSON.stringify({
    model,
    llmRevision: revision,
    status: "passed",
    messages: agent.state.messages.length,
    toolCalls: agent.state.messages.filter((m) => m.role === "toolResult")
      .length,
  }),
);
