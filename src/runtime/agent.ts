// Adapted from pi's Agent wrapper and queue semantics.
// Copyright (c) 2025 Mario Zechner. SPDX-License-Identifier: MIT.
// See THIRD_PARTY_NOTICES.md and licenses/pi-MIT.txt.
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  QueueMode,
  RunEndReason,
  StreamFn,
} from "./types.js";

export interface AgentOptions extends Omit<
  AgentLoopConfig,
  "getSteeringMessages" | "getFollowUpMessages" | "hasQueuedMessages"
> {
  streamFn: StreamFn;
  systemPrompt?: string;
  messages?: AgentMessage[];
  tools?: AgentTool<any>[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}

class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  constructor(public mode: QueueMode) {}
  enqueue(message: AgentMessage) {
    this.messages.push(structuredClone(message));
  }
  drain() {
    return this.messages.splice(
      0,
      this.mode === "all" ? this.messages.length : 1,
    );
  }
  clear() {
    this.messages = [];
  }
  get size() {
    return this.messages.length;
  }
}

/** Each test run owns one Agent; never share its transcript across projects/environments. */
export class Agent {
  private messages: AgentMessage[];
  private readonly tools: AgentTool<any>[];
  private readonly baseline: AgentMessage[];
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => void | Promise<void>
  >();
  private readonly steering: PendingMessageQueue;
  private readonly followUps: PendingMessageQueue;
  private active?: {
    controller: AbortController;
    settled: Promise<void>;
    resolve: () => void;
  };
  private streamingMessage?: AgentMessage;
  private pendingToolCalls = new Set<string>();
  private errorMessage?: string;
  private lastEndReason?: RunEndReason;

  constructor(private readonly options: AgentOptions) {
    this.messages = structuredClone(options.messages ?? []);
    if (options.systemPrompt && this.messages[0]?.role !== "system") {
      this.messages.unshift({
        role: "system",
        content: options.systemPrompt,
        timestamp: Date.now(),
      });
    }
    this.baseline = structuredClone(
      this.messages.filter((m) => m.role === "system"),
    );
    this.tools = options.tools?.slice() ?? [];
    this.steering = new PendingMessageQueue(
      options.steeringMode ?? "one-at-a-time",
    );
    this.followUps = new PendingMessageQueue(
      options.followUpMode ?? "one-at-a-time",
    );
  }

  /** Snapshots cannot mutate a live run. Persist messages alongside model/tool configuration. */
  get state() {
    return {
      messages: structuredClone(this.messages),
      isStreaming: !!this.active,
      streamingMessage: structuredClone(this.streamingMessage),
      pendingToolCalls: new Set(this.pendingToolCalls),
      errorMessage: this.errorMessage,
      lastEndReason: this.lastEndReason,
    };
  }

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>,
  ) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  steer(input: string | AgentMessage) {
    this.steering.enqueue(toMessage(input));
  }
  followUp(input: string | AgentMessage) {
    this.followUps.enqueue(toMessage(input));
  }
  hasQueuedMessages() {
    return this.steering.size + this.followUps.size > 0;
  }
  clearAllQueues() {
    this.steering.clear();
    this.followUps.clear();
  }
  abort() {
    this.active?.controller.abort();
  }
  waitForIdle() {
    return this.active?.settled ?? Promise.resolve();
  }

  reset() {
    this.assertIdle();
    this.messages = structuredClone(this.baseline);
    this.errorMessage = undefined;
    this.lastEndReason = undefined;
    this.clearAllQueues();
  }

  async prompt(input: string | AgentMessage | AgentMessage[]) {
    this.assertIdle();
    const messages = Array.isArray(input) ? input : [toMessage(input)];
    if (!messages.length) throw new Error("Prompt must contain a message");
    return this.run(structuredClone(messages));
  }

  async continue() {
    this.assertIdle();
    if (!this.messages.some((m) => m.role !== "system"))
      throw new Error("No messages to continue from");
    if (this.messages.at(-1)?.role === "assistant") {
      const steering = this.steering.drain();
      if (steering.length) return this.run(steering, true);
      const followUps = this.followUps.drain();
      if (followUps.length) return this.run(followUps);
      throw new Error("Cannot continue from assistant without queued input");
    }
    return this.run();
  }

  private assertIdle() {
    if (this.active)
      throw new Error("Agent is already running; use steer() or followUp()");
  }

  private async run(prompts?: AgentMessage[], skipInitialSteering = false) {
    this.assertIdle();
    let resolve = () => {};
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    const controller = new AbortController();
    this.active = { settled, resolve, controller };
    this.errorMessage = undefined;
    this.lastEndReason = undefined;
    const config: AgentLoopConfig = {
      ...this.options,
      getSteeringMessages: () => {
        if (skipInitialSteering) {
          skipInitialSteering = false;
          return [];
        }
        return this.steering.drain();
      },
      getFollowUpMessages: () => this.followUps.drain(),
      hasQueuedMessages: () => this.hasQueuedMessages(),
    };
    const context = { messages: this.messages, tools: this.tools };
    try {
      if (prompts)
        return await runAgentLoop(
          prompts,
          context,
          config,
          (event) => this.emit(event),
          controller.signal,
          this.options.streamFn,
        );
      return await runAgentLoopContinue(
        context,
        config,
        (event) => this.emit(event),
        controller.signal,
        this.options.streamFn,
      );
    } catch (error) {
      // A failed event sink must reject, not emit a second terminal lifecycle or hide data loss.
      this.errorMessage =
        error instanceof Error ? error.message : String(error);
      this.lastEndReason = controller.signal.aborted ? "aborted" : "error";
      throw error;
    } finally {
      this.streamingMessage = undefined;
      this.pendingToolCalls.clear();
      this.active = undefined;
      resolve();
    }
  }

  private async emit(event: AgentEvent) {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.streamingMessage = structuredClone(event.message);
        break;
      case "message_end":
        this.streamingMessage = undefined;
        this.messages.push(structuredClone(event.message));
        break;
      case "tool_execution_start":
        this.pendingToolCalls.add(event.toolCallId);
        break;
      case "tool_execution_end":
        this.pendingToolCalls.delete(event.toolCallId);
        break;
      case "turn_end":
        this.errorMessage = event.message.errorMessage;
        break;
      case "agent_end":
        this.lastEndReason = event.reason;
        break;
    }
    for (const listener of this.listeners)
      await listener(structuredClone(event), this.active!.controller.signal);
  }
}

function toMessage(input: string | AgentMessage): AgentMessage {
  return typeof input === "string"
    ? {
        role: "user",
        content: [{ type: "text", text: input }],
        timestamp: Date.now(),
      }
    : structuredClone(input);
}
