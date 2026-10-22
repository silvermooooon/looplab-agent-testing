// Adapted from pi Agent. Copyright (c) 2025 Mario Zechner.
// SPDX-License-Identifier: MIT — see THIRD_PARTY_NOTICES.md and licenses/pi-MIT.txt.

export type MaybePromise<T> = T | Promise<T>;
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export type Content = TextContent | ImageContent;
export interface AgentToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}
export interface UserMessage {
  role: "user";
  content: Content[];
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: (Content | AgentToolCall)[];
  timestamp: number;
  stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
  errorMessage?: string;
  /** Exact Responses output (including encrypted reasoning) for stateless replay. */
  responseItems?: JsonValue[];
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Content[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
export type Message =
  SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface CustomAgentMessages {}
export type AgentMessage =
  Message | CustomAgentMessages[keyof CustomAgentMessages];
export type ToolExecutionMode = "sequential" | "parallel";
export type QueueMode = "all" | "one-at-a-time";
export interface AgentToolResult<T = unknown> {
  content: Content[];
  details?: T;
  structuredContent?: JsonValue;
  isError?: boolean;
  terminate?: boolean;
}
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}
export interface AgentTool<T = unknown> extends ToolDeclaration {
  executionMode?: ToolExecutionMode;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    args: T,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult) => void,
  ) => Promise<AgentToolResult>;
}
export interface AgentContext {
  messages: AgentMessage[];
  // Tool parameter types are validated at the runtime boundary using JSON Schema.
  tools?: AgentTool<any>[];
}
export interface ModelRequest {
  messages: Message[];
  tools: ToolDeclaration[];
  signal?: AbortSignal;
}
export type ModelStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "update"; partial: AssistantMessage; delta?: string }
  | { type: "done"; message: AssistantMessage };
/** Provider adapters must end with exactly one done event and honor AbortSignal. */
export type StreamFn = (
  request: ModelRequest,
) => MaybePromise<AsyncIterable<ModelStreamEvent>>;
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; reason: RunEndReason }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: AssistantMessage;
      toolResults: ToolResultMessage[];
    }
  | { type: "message_start" | "message_end"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; delta?: string }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };
export type RunEndReason = "completed" | "aborted" | "error" | "max_turns";
export type AgentEventSink = (event: AgentEvent) => MaybePromise<void>;
export interface AgentTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}
export interface AfterToolCallContext extends BeforeToolCallContext {
  result: AgentToolResult;
  isError: boolean;
}
export interface AgentToolCallOutcome {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
}
export interface ToolCallHooks {
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => MaybePromise<{
    block?: boolean;
    reason?: string;
    terminate?: boolean;
  } | void>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => MaybePromise<Partial<AgentToolResult> | void>;
}
export interface AgentLoopConfig extends ToolCallHooks {
  /** Default 40. A bound is required even for repeated tool errors or length stops. */
  maxTurns?: number;
  /** Sequential by default; a sequential tool also forces the whole batch to serialize. */
  toolExecution?: ToolExecutionMode;
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => MaybePromise<AgentMessage[]>;
  convertToLlm?: (messages: AgentMessage[]) => MaybePromise<Message[]>;
  prepareRequest?: (
    context: AgentContext,
    signal?: AbortSignal,
  ) => MaybePromise<AgentContext | void>;
  finishTurn?: (
    turn: AgentTurnContext,
    signal?: AbortSignal,
  ) => MaybePromise<{ action: "end" | "continue" } | void>;
  getSteeringMessages?: () => MaybePromise<AgentMessage[]>;
  getFollowUpMessages?: () => MaybePromise<AgentMessage[]>;
  /** Non-destructive queue check at the turn limit. */
  hasQueuedMessages?: () => boolean;
}
