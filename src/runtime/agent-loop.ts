// Reworked from pi's nested tool/steering/follow-up loop and message lifecycle.
// Copyright (c) 2025 Mario Zechner. SPDX-License-Identifier: MIT.
// See THIRD_PARTY_NOTICES.md and licenses/pi-MIT.txt.
import { executeToolCalls } from "./tool-executor.js";
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  Message,
  StreamFn,
  ToolResultMessage,
  RunEndReason,
} from "./types.js";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((message): message is Message =>
    ["system", "user", "assistant", "toolResult"].includes(message.role),
  );
}

/** Awaited event sinks form a persistence barrier before any tool side effect. */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  return run(prompts, context, config, emit, signal, streamFn);
}

export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  if (!context.messages.some((m) => m.role !== "system"))
    throw new Error("No messages to continue from");
  if (context.messages.at(-1)?.role === "assistant")
    throw new Error("Cannot continue from assistant without queued input");
  return run([], context, config, emit, signal, streamFn);
}

async function run(
  prompts: AgentMessage[],
  initial: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const maxTurns = config.maxTurns ?? 40;
  if (!Number.isInteger(maxTurns) || maxTurns < 1)
    throw new Error("maxTurns must be a positive integer");
  const names = initial.tools?.map((t) => t.name) ?? [];
  if (new Set(names).size !== names.length)
    throw new Error("Tool names must be unique");
  let context: AgentContext = {
    ...initial,
    messages: structuredClone(initial.messages),
    tools: initial.tools?.slice(),
  };
  const newMessages: AgentMessage[] = [];
  let turns = 0;
  let reason: RunEndReason = "completed";
  let pending = structuredClone(prompts);

  // Subscriber failures intentionally reject the invocation; don't pretend failed persistence succeeded.
  await emit({ type: "agent_start" });
  pending.push(...((await config.getSteeringMessages?.()) ?? []));
  while (true) {
    await emit({ type: "turn_start" });
    for (const message of pending) {
      context.messages.push(message);
      newMessages.push(message);
      await emit({ type: "message_start", message: structuredClone(message) });
      await emit({ type: "message_end", message: structuredClone(message) });
    }
    pending = [];
    let message: AssistantMessage;
    // Prepare/convert failures are runtime failures, not model-authored text.
    let requestMessages: Message[] = [];
    let failure: string | undefined;
    try {
      signal?.throwIfAborted();
      context = (await config.prepareRequest?.(context, signal)) || context;
      const transformed =
        (await config.transformContext?.(
          structuredClone(context.messages),
          signal,
        )) ?? context.messages;
      requestMessages = await (config.convertToLlm ?? defaultConvertToLlm)(
        structuredClone(transformed),
      );
      signal?.throwIfAborted();
    } catch (error) {
      failure = errorText(error);
    }

    if (failure !== undefined || signal?.aborted) {
      message = failedMessage(failure ?? "Operation aborted", signal);
      await emit({ type: "message_start", message });
      await emit({ type: "message_end", message });
    } else {
      message = await streamAssistant(
        context,
        requestMessages,
        streamFn,
        emit,
        signal,
      );
    }
    context.messages.push(message);
    newMessages.push(message);
    turns++;
    let toolResults: ToolResultMessage[] = [];
    let continueForTools = false;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      const calls = message.content.filter((c) => c.type === "toolCall");
      if (calls.length) {
        if (message.stopReason === "length") {
          // Directly preserve pi's rule: even parseable truncated arguments must never execute.
          for (const call of calls) {
            const result = {
              content: [
                {
                  type: "text" as const,
                  text: "Tool not executed: response was truncated; re-issue complete arguments.",
                },
              ],
              isError: true,
            };
            const toolMessage: ToolResultMessage = {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content,
              isError: true,
              timestamp: Date.now(),
            };
            await emit({
              type: "tool_execution_start",
              toolCallId: call.id,
              toolName: call.name,
              args: call.arguments,
            });
            await emit({
              type: "tool_execution_end",
              toolCallId: call.id,
              toolName: call.name,
              result,
              isError: true,
            });
            await emit({ type: "message_start", message: toolMessage });
            await emit({ type: "message_end", message: toolMessage });
            toolResults.push(toolMessage);
          }
          continueForTools = true;
        } else {
          const batch = await executeToolCalls(
            context,
            message,
            { ...config, toolExecution: config.toolExecution ?? "sequential" },
            signal,
            emit,
          );
          toolResults = batch.messages;
          continueForTools = !batch.terminate;
        }
        context.messages.push(...toolResults);
        newMessages.push(...toolResults);
      }
    }
    const decision = await config.finishTurn?.(
      { message, toolResults, context, newMessages },
      signal,
    );
    await emit({ type: "turn_end", message, toolResults });
    if (message.stopReason === "aborted" || signal?.aborted) {
      reason = "aborted";
      break;
    }
    if (message.stopReason === "error") {
      reason = "error";
      break;
    }
    if (decision?.action === "end") break;

    // Peek/drain queues only if another request can actually be made.
    if (turns >= maxTurns) {
      reason =
        continueForTools ||
        decision?.action === "continue" ||
        config.hasQueuedMessages?.()
          ? "max_turns"
          : "completed";
      break;
    }
    pending = (await config.getSteeringMessages?.()) ?? [];
    if (continueForTools || pending.length) continue;
    pending = (await config.getFollowUpMessages?.()) ?? [];
    if (pending.length || decision?.action === "continue") continue;
    break;
  }
  await emit({
    type: "agent_end",
    messages: structuredClone(newMessages),
    reason,
  });
  return newMessages;
}

function failedMessage(error: string, signal?: AbortSignal): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    timestamp: Date.now(),
    stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: error,
  };
}

async function streamAssistant(
  context: AgentContext,
  messages: Message[],
  streamFn: StreamFn,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  let started = false;
  let final: AssistantMessage | undefined;
  let iterator:
    AsyncIterator<import("./types.js").ModelStreamEvent> | undefined;
  try {
    const stream = await streamFn({
      messages,
      tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
      signal,
    });
    iterator = stream[Symbol.asyncIterator]();
  } catch (error) {
    final = failedMessage(errorText(error), signal);
  }

  try {
    while (iterator && !final) {
      let next: IteratorResult<import("./types.js").ModelStreamEvent>;
      try {
        signal?.throwIfAborted();
        next = await iterator.next();
        signal?.throwIfAborted();
      } catch (error) {
        final = failedMessage(errorText(error), signal);
        break;
      }
      if (next.done) {
        final = failedMessage(
          "Model stream ended without a done event",
          signal,
        );
        break;
      }
      const event = next.value;
      if (event.type === "done") {
        final = structuredClone(event.message);
      } else {
        if (!started) {
          started = true;
          await emit({
            type: "message_start",
            message: structuredClone(event.partial),
          });
        }
        if (event.type === "update")
          await emit({
            type: "message_update",
            message: structuredClone(event.partial),
            delta: event.delta,
          });
      }
    }
  } finally {
    // Close the provider stream after completion or subscriber failure.
    if (iterator?.return) await iterator.return();
  }
  final ??= failedMessage("Model stream produced no result", signal);
  if (!started)
    await emit({ type: "message_start", message: structuredClone(final) });
  await emit({ type: "message_end", message: structuredClone(final) });
  return final;
}
