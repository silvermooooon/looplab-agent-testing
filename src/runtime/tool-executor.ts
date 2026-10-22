// Adapted from pi packages/agent/src/agent-loop.ts at 83692682f095528f8b71652ddacff7075e36e893.
// Copyright (c) 2025 Mario Zechner. SPDX-License-Identifier: MIT.
// See THIRD_PARTY_NOTICES.md and licenses/pi-MIT.txt for source and modifications.
import type {
  AgentContext,
  AssistantMessage,
  AgentToolCall,
  AgentLoopConfig,
  AgentEventSink,
  ToolResultMessage,
  AgentToolCallOutcome,
  AgentToolResult,
  AgentTool,
} from "./types.js";
import { validateToolArguments } from "./validation.js";

export async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(
    (c) => c.type === "toolCall",
  );
  const hasSequentialToolCall = toolCalls.some(
    (tc) =>
      currentContext.tools?.find((t) => t.name === tc.name)?.executionMode ===
      "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
  );
}

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  terminate: boolean;
};

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
    } else {
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emitToolExecutionUpdate(toolCall, emit),
      );
      finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
  };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    if (preparation.kind === "immediate") {
      const finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      } satisfies FinalizedToolCallOutcome;
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      continue;
    }

    finalizedCalls.push(async () => {
      if (signal?.aborted) {
        const finalized = {
          toolCall,
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        } satisfies FinalizedToolCallOutcome;
        await emitToolExecutionEnd(finalized, emit);
        return finalized;
      }
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emitToolExecutionUpdate(toolCall, emit),
      );
      const finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
  }

  // Settle every started task before exposing a failure; no tools may outlive the run.
  const settled = await Promise.allSettled(
    finalizedCalls.map((entry) =>
      typeof entry === "function" ? entry() : Promise.resolve(entry),
    ),
  );
  const failed = settled.find((entry) => entry.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const orderedFinalizedCalls = settled.map((entry) => {
    if (entry.status === "rejected") throw entry.reason;
    return entry.value;
  });
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
  };
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<any>;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult<any>;
  isError: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<
  AgentLoopConfig,
  "beforeToolCall" | "afterToolCall"
>;

type ToolUpdateSink = (
  partialResult: AgentToolResult<any>,
) => Promise<void> | void;

type FinalizedToolCallEntry =
  FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(
  finalizedCalls: FinalizedToolCallOutcome[],
): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every((finalized) => finalized.result.terminate === true)
  );
}

function prepareToolCallArguments(
  tool: AgentTool<any>,
  toolCall: AgentToolCall,
): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(
    structuredClone(toolCall.arguments),
  );
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, any>,
  };
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: ToolCallHooks,
  signal: AbortSignal | undefined,
  tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }
      if (beforeResult?.block) {
        const result = createErrorToolResult(
          beforeResult.reason || "Tool execution was blocked",
        );
        if (beforeResult.terminate === true) {
          result.terminate = true;
        }
        return {
          kind: "immediate",
          result,
          isError: true,
        };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  }
}

function emitToolExecutionUpdate(
  toolCall: AgentToolCall,
  emit: AgentEventSink,
): ToolUpdateSink {
  return (partialResult) =>
    emit({
      type: "tool_execution_update",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      partialResult,
    });
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
  /** Tools the call resolves against. */
  tools: readonly AgentTool<any>[];
  /** Passed to the hooks as the message that issued the call. */
  assistantMessage: AssistantMessage;
  /** Passed to the hooks as the current agent context. */
  context: AgentContext;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(
  toolCall: AgentToolCall,
  options: RunToolCallOptions,
): Promise<AgentToolCallOutcome> {
  const { assistantMessage, context, signal } = options;
  const preparation = await prepareToolCall(
    context,
    assistantMessage,
    toolCall,
    options,
    signal,
    options.tools,
  );
  if (preparation.kind === "immediate") {
    return {
      toolCall,
      result: preparation.result,
      isError: preparation.isError,
    };
  }
  const executed = await executePreparedToolCall(
    preparation,
    signal,
    options.onUpdate ?? (() => {}),
  );
  return finalizeExecutedToolCall(
    context,
    assistantMessage,
    preparation,
    executed,
    options,
    signal,
  );
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;
  let updateFailed = false;
  let updateError: unknown;
  let outcome: ExecutedToolCallOutcome;
  try {
    signal?.throwIfAborted();
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as never,
      signal,
      (partial) => {
        if (!acceptingUpdates) return;
        const snapshot = structuredClone(partial);
        // Attach rejection handling immediately, even if the tool does not await updates.
        updateEvents.push(
          Promise.resolve()
            .then(() => onUpdate(snapshot))
            .catch((error) => {
              updateFailed = true;
              updateError = error;
            }),
        );
      },
    );
    outcome = { result, isError: result.isError === true };
  } catch (error) {
    outcome = {
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
  await Promise.all(updateEvents);
  if (updateFailed) throw updateError;
  return outcome;
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: ToolCallHooks,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        // Structured content not replaced along with the content may no longer match it.
        const structuredContent =
          afterResult.structuredContent ??
          (afterResult.content ? undefined : result.structuredContent);
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        if (structuredContent === undefined) delete result.structuredContent;
        else result.structuredContent = structuredContent;
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      );
      isError = true;
    }
  }

  return {
    toolCall: prepared.toolCall,
    result: { ...result, isError },
    isError,
  };
}

function createErrorToolResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(
  finalized: FinalizedToolCallOutcome,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    // Untyped tools (JS extensions) can return results without content; normalize
    // so the null never enters session history or provider payloads.
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}
