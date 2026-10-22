import OpenAI from "openai";
import type {
  ResponseInput,
  ResponseOutputItem,
  Response,
} from "openai/resources/responses/responses.js";
import type {
  AssistantMessage,
  JsonValue,
  Message,
  StreamFn,
} from "../runtime/index.js";

export const MODEL = "gpt-6-luna" as const;
export function responseInput(messages: Message[]): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (message.role === "system")
      input.push({ role: "developer", content: message.content });
    if (message.role === "user")
      input.push({
        role: "user",
        content: message.content.map((c) =>
          c.type === "text"
            ? { type: "input_text" as const, text: c.text }
            : {
                type: "input_image" as const,
                image_url: `data:${c.mimeType};base64,${c.data}`,
                detail: "auto" as const,
              },
        ),
      });
    if (message.role === "toolResult")
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: JSON.stringify({
          isError: message.isError,
          content: message.content,
        }),
      });
    if (message.role === "assistant") {
      if (message.responseItems)
        input.push(...(message.responseItems as unknown as ResponseInput));
      else
        for (const block of message.content) {
          if (block.type === "text")
            input.push({ role: "assistant", content: block.text });
          if (block.type === "toolCall")
            input.push({
              type: "function_call",
              name: block.name,
              call_id: block.id,
              arguments: JSON.stringify(block.arguments),
            });
        }
    }
  }
  return input;
}
export function assistantFromResponse(
  response: Pick<
    Response,
    "output" | "status" | "error" | "incomplete_details"
  >,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const item of response.output) {
    if (item.type === "message")
      for (const block of item.content) {
        if (block.type === "output_text")
          content.push({ type: "text", text: block.text });
        if (block.type === "refusal")
          throw new Error(`Model refused: ${block.refusal}`);
      }
    if (item.type === "function_call") {
      if (response.status === "incomplete") continue;
      const args: unknown = JSON.parse(item.arguments);
      if (!args || Array.isArray(args) || typeof args !== "object")
        throw new Error("Invalid tool arguments from model");
      content.push({
        type: "toolCall",
        id: item.call_id,
        name: item.name,
        arguments: args as Record<string, unknown>,
      });
    }
  }
  const stopReason =
    response.status === "failed"
      ? "error"
      : response.status === "incomplete"
        ? "error"
        : content.some((c) => c.type === "toolCall")
          ? "toolUse"
          : "stop";
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason,
    errorMessage:
      response.status === "failed"
        ? (response.error?.message ?? "Responses request failed")
        : response.status === "incomplete"
          ? `Responses output incomplete: ${response.incomplete_details?.reason}`
          : undefined,
    responseItems: response.output as unknown as JsonValue[],
  };
}
export function createResponsesStream(options: {
  apiKey: string;
  baseURL: string;
}): StreamFn {
  const client = new OpenAI({ ...options, timeout: 120000, maxRetries: 1 });
  return async function* ({ messages, tools, signal }) {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      stopReason: "stop",
    };
    yield { type: "start", partial };
    const stream = await client.responses.create(
      {
        model: MODEL,
        input: responseInput(messages),
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low" },
        max_output_tokens: 10000,
        parallel_tool_calls: false,
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
      },
      { signal },
    );
    try {
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          const existing = partial.content[0];
          if (existing?.type === "text") existing.text += event.delta;
          else partial.content.push({ type: "text", text: event.delta });
          yield {
            type: "update",
            partial: structuredClone(partial),
            delta: event.delta,
          };
        }
        if (
          event.type === "response.completed" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        ) {
          yield {
            type: "done",
            message: assistantFromResponse(event.response),
          };
          return;
        }
        if (event.type === "error") throw new Error(event.message);
      }
    } finally {
      stream.controller.abort();
    }
    throw new Error("Responses stream ended without a terminal event");
  };
}
