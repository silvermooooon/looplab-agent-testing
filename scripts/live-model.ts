import { Agent } from "../src/runtime/index.js";
import { createResponsesStream, MODEL } from "../src/openai/responses.js";
import { config } from "../src/server/config.js";
const agent = new Agent({
  streamFn: createResponsesStream({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
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
    `Live model check failed: ${agent.state.errorMessage ?? agent.state.lastEndReason}`,
  );
console.log(
  JSON.stringify({
    model: MODEL,
    status: "passed",
    messages: agent.state.messages.length,
    toolCalls: agent.state.messages.filter((m) => m.role === "toolResult")
      .length,
  }),
);
