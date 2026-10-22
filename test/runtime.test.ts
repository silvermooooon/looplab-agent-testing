import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Agent,
  runAgentLoop,
  runToolCall,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
  type AssistantMessage,
  type ModelRequest,
  type StreamFn,
  type AgentToolCall,
} from "../src/runtime/index.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (
  id = "one",
  name = "echo",
  args: Record<string, unknown> = { value: "hello" },
): AgentToolCall => ({ type: "toolCall", id, name, arguments: args });
const reply = (
  content: AssistantMessage["content"] = [text("done")],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: Date.now(),
});
function fixture(responses: AssistantMessage[]) {
  const requests: ModelRequest[] = [];
  const streamFn: StreamFn = async function* (request) {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    const message = responses.shift();
    if (!message) throw new Error("Unexpected model request");
    yield { type: "done", message };
  };
  return { requests, streamFn };
}
const echo: AgentTool<{ value: string }> = {
  name: "echo",
  description: "Echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  async execute(_id, args) {
    return { content: [text(args.value)] };
  },
};
function harness(options: AgentOptions) {
  const agent = new Agent(options);
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, events };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("tool result feeds the next model turn and final lifecycle is emitted once", async () => {
  const f = fixture([reply([call()], "toolUse"), reply()]);
  const { agent, events } = harness({ streamFn: f.streamFn, tools: [echo] });
  await agent.prompt("test");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.messages.at(-1)!.role, "toolResult");
  assert.deepEqual(
    agent.state.messages.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
  assert.equal(agent.state.lastEndReason, "completed");
  assert.equal(agent.state.isStreaming, false);
});

test("awaited assistant message persistence completes before tool execution", async () => {
  const saved = deferred();
  const entered = deferred();
  let executed = false;
  const f = fixture([reply([call()], "toolUse"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute() {
          executed = true;
          return { content: [] };
        },
      },
    ],
  });
  agent.subscribe(async (event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "toolUse"
    ) {
      assert.equal(agent.state.messages.at(-1)?.role, "assistant");
      entered.resolve();
      await saved.promise;
    }
  });
  const run = agent.prompt("test");
  await entered.promise;
  assert.equal(executed, false);
  saved.resolve();
  await run;
  assert.equal(executed, true);
});

test("default sequential mode preserves browser side effect order", async () => {
  const order: string[] = [];
  const f = fixture([reply([call("a"), call("b")], "toolUse"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute(id) {
          order.push(`start:${id}`);
          await Promise.resolve();
          order.push(`end:${id}`);
          return { content: [] };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
});

test("parallel tools finish out of order but transcript retains original order", async () => {
  const bFinished = deferred();
  const f = fixture([reply([call("a"), call("b")], "toolUse"), reply()]);
  const { agent, events } = harness({
    streamFn: f.streamFn,
    toolExecution: "parallel",
    tools: [
      {
        ...echo,
        async execute(id) {
          if (id === "a") await bFinished.promise;
          else bFinished.resolve();
          return { content: [text(id)] };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.deepEqual(
    events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => e.toolCallId),
    ["b", "a"],
  );
  assert.deepEqual(
    agent.state.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId),
    ["a", "b"],
  );
});

test("one sequential tool overrides parallel batch configuration", async () => {
  const order: string[] = [];
  const f = fixture([
    reply([call("a"), call("b", "browser")], "toolUse"),
    reply(),
  ]);
  const execute: AgentTool["execute"] = async (id) => {
    order.push(`start:${id}`);
    await Promise.resolve();
    order.push(`end:${id}`);
    return { content: [] };
  };
  await new Agent({
    streamFn: f.streamFn,
    toolExecution: "parallel",
    tools: [
      { ...echo, execute },
      { ...echo, name: "browser", executionMode: "sequential", execute },
    ],
  }).prompt("test");
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
});

for (const [name, toolCall] of [
  ["unknown tool", call("a", "missing")],
  ["wrong argument type", call("a", "echo", { value: 42 })],
  ["missing argument", call("a", "echo", {})],
  ["extra argument", call("a", "echo", { value: "x", extra: true })],
] as const) {
  test(`${name} returns an error result without executing`, async () => {
    let ran = false;
    const f = fixture([reply([toolCall], "toolUse"), reply()]);
    const agent = new Agent({
      streamFn: f.streamFn,
      tools: [
        {
          ...echo,
          async execute() {
            ran = true;
            return { content: [] };
          },
        },
      ],
    });
    await agent.prompt("test");
    assert.equal(ran, false);
    assert.equal(
      agent.state.messages.find((m) => m.role === "toolResult")?.isError,
      true,
    );
  });
}

test("length-truncated calls never execute even if their arguments validate", async () => {
  let ran = false;
  const f = fixture([reply([call()], "length"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute() {
          ran = true;
          return { content: [] };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.equal(ran, false);
  assert.equal(f.requests.length, 2);
});

test("before hook can block and terminate without another model call", async () => {
  let ran = false;
  const f = fixture([reply([call()], "toolUse")]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute() {
          ran = true;
          return { content: [] };
        },
      },
    ],
    beforeToolCall: () => ({
      block: true,
      reason: "environment blocked",
      terminate: true,
    }),
  });
  await agent.prompt("test");
  assert.equal(ran, false);
  assert.equal(agent.state.lastEndReason, "completed");
  assert.equal(f.requests.length, 1);
});

test("mixed terminating tool batch still continues", async () => {
  const f = fixture([reply([call("a"), call("b")], "toolUse"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute(id) {
          return { content: [], terminate: id === "a" };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.equal(f.requests.length, 2);
});

test("after hook drops stale structured content when replacing text", async () => {
  const tool = {
    ...echo,
    async execute() {
      return { content: [text("raw")], structuredContent: { raw: true } };
    },
  };
  const outcome = await runToolCall(call(), {
    tools: [tool],
    context: { messages: [] },
    assistantMessage: reply(),
    afterToolCall: () => ({ content: [text("redacted")], isError: true }),
  });
  assert.equal(outcome.result.structuredContent, undefined);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.result.isError, true);
});

test("tool exceptions become model-visible errors", async () => {
  const f = fixture([reply([call()], "toolUse"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute() {
          throw new Error("page closed");
        },
      },
    ],
  });
  await agent.prompt("test");
  const result = agent.state.messages.find((m) => m.role === "toolResult");
  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [text("page closed")]);
});

test("cancellation skips remaining tools but preserves one result per call", async () => {
  const f = fixture([reply([call("a"), call("b")], "toolUse")]);
  const executed: string[] = [];
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute(id) {
          executed.push(id);
          agent.abort();
          return { content: [] };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.deepEqual(executed, ["a"]);
  const results = agent.state.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 2);
  assert.equal(results[1]?.isError, true);
  assert.equal(agent.state.lastEndReason, "aborted");
  assert.equal(f.requests.length, 1);
});

test("abort during provider streaming closes the iterator and ends once", async () => {
  const entered = deferred();
  let closed = false;
  const streamFn: StreamFn = async function* ({ signal }) {
    try {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", message: reply() };
    } finally {
      closed = true;
    }
  };
  const { agent, events } = harness({ streamFn });
  const run = agent.prompt("test");
  await entered.promise;
  agent.abort();
  await run;
  assert.equal(closed, true);
  assert.equal(agent.state.lastEndReason, "aborted");
  assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
});

test("provider exceptions and incomplete streams finalize with error", async () => {
  for (const streamFn of [
    (() => {
      throw new Error("network failed");
    }) as StreamFn,
    async function* () {
      yield { type: "start" as const, partial: reply([]) };
    } as StreamFn,
  ]) {
    const { agent, events } = harness({ streamFn });
    await agent.prompt("test");
    assert.equal(agent.state.lastEndReason, "error");
    assert.equal(
      events.filter(
        (e) => e.type === "message_end" && e.message.role === "assistant",
      ).length,
      1,
    );
    assert.equal(events.at(-1)?.type, "agent_end");
  }
});

test("streaming updates are independent snapshots", async () => {
  const streamFn: StreamFn = async function* () {
    const message = reply([text("a")]);
    yield { type: "start", partial: message };
    message.content = [text("ab")];
    yield { type: "update", partial: message, delta: "b" };
    message.content = [text("abc")];
    yield { type: "done", message };
  };
  const { agent, events } = harness({ streamFn });
  await agent.prompt("test");
  const update = events.find((e) => e.type === "message_update");
  assert.deepEqual(update?.message.content, [text("ab")]);
  assert.deepEqual(agent.state.messages.at(-1)?.content, [text("abc")]);
});

test("finishTurn continuation is satisfied by a natural tool turn exactly once", async () => {
  const f = fixture([reply([call()], "toolUse"), reply()]);
  let count = 0;
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [echo],
    finishTurn() {
      if (++count === 1) return { action: "continue" };
    },
  });
  await agent.prompt("test");
  assert.equal(f.requests.length, 2);
});

test("finishTurn can force one context-only turn and end without draining queues", async () => {
  const f = fixture([reply(), reply()]);
  let count = 0;
  const agent = new Agent({
    streamFn: f.streamFn,
    finishTurn() {
      if (++count === 1) return { action: "continue" };
      agent.followUp("later");
      return { action: "end" };
    },
  });
  await agent.prompt("test");
  assert.equal(f.requests.length, 2);
  assert.equal(agent.hasQueuedMessages(), true);
});

test("steering arrives after the current tool batch; follow-up waits for natural finish", async () => {
  const f = fixture([
    reply([call("a"), call("b")], "toolUse"),
    reply(),
    reply(),
  ]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        async execute(id) {
          if (id === "a") {
            agent.steer("steer");
            agent.followUp("follow");
          }
          return { content: [] };
        },
      },
    ],
  });
  await agent.prompt("test");
  assert.deepEqual(
    f.requests[1]!.messages.slice(-3).map((m) => m.role),
    ["toolResult", "toolResult", "user"],
  );
  assert.deepEqual(f.requests[1]!.messages.at(-1)?.content, [text("steer")]);
  assert.deepEqual(f.requests[2]!.messages.at(-1)?.content, [text("follow")]);
});

test("turn limit bounds repeated model tools and preserves queued messages", async () => {
  const f = fixture([reply([call()], "toolUse")]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [echo],
    maxTurns: 1,
    finishTurn() {
      agent.followUp("must not disappear");
    },
  });
  await agent.prompt("test");
  assert.equal(agent.state.lastEndReason, "max_turns");
  assert.equal(agent.hasQueuedMessages(), true);
  assert.equal(f.requests.length, 1);
});

test("normal completion on the last allowed turn is successful", async () => {
  const f = fixture([reply()]);
  const agent = new Agent({ streamFn: f.streamFn, maxTurns: 1 });
  await agent.prompt("test");
  assert.equal(agent.state.lastEndReason, "completed");
});

test("continue from assistant drains one steering message per turn", async () => {
  const f = fixture([reply(), reply(), reply()]);
  const agent = new Agent({ streamFn: f.streamFn });
  await agent.prompt("test");
  agent.steer("one");
  agent.steer("two");
  await agent.continue();
  assert.deepEqual(f.requests[1]!.messages.at(-1)?.content, [text("one")]);
  assert.equal(
    f.requests[1]!.messages.filter((m) => m.role === "user").length,
    2,
  );
  assert.deepEqual(f.requests[2]!.messages.at(-1)?.content, [text("two")]);
});

test("continue rejects empty/system-only history without consuming queued messages", async () => {
  const agent = new Agent({
    streamFn: fixture([]).streamFn,
    systemPrompt: "system",
  });
  agent.steer("pending");
  await assert.rejects(agent.continue(), /No messages/);
  assert.equal(agent.hasQueuedMessages(), true);
});

test("continuation from restored user history does not append the user twice", async () => {
  const f = fixture([reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    messages: [{ role: "user", content: [text("restored")], timestamp: 0 }],
  });
  await agent.continue();
  assert.equal(agent.state.messages.length, 2);
});

test("busy guard includes awaited agent_end subscribers and waitForIdle", async () => {
  const finish = deferred();
  const entered = deferred();
  const agent = new Agent({ streamFn: fixture([reply()]).streamFn });
  agent.subscribe(async (event) => {
    if (event.type === "agent_end") {
      entered.resolve();
      await finish.promise;
    }
  });
  const run = agent.prompt("test");
  await entered.promise;
  let idle = false;
  const waiting = agent.waitForIdle().then(() => {
    idle = true;
  });
  await assert.rejects(agent.prompt("collision"), /already running/);
  assert.throws(() => agent.reset(), /already running/);
  assert.equal(idle, false);
  finish.resolve();
  await run;
  await waiting;
  assert.equal(idle, true);
});

test("subscriber failure prevents tool side effects and releases busy state", async () => {
  let executed = false;
  const { agent, events } = harness({
    streamFn: fixture([reply([call()], "toolUse")]).streamFn,
    tools: [
      {
        ...echo,
        async execute() {
          executed = true;
          return { content: [] };
        },
      },
    ],
  });
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant")
      throw new Error("disk full");
  });
  await assert.rejects(agent.prompt("test"), /disk full/);
  assert.equal(executed, false);
  assert.equal(agent.state.isStreaming, false);
  assert.equal(events.filter((e) => e.type === "agent_end").length, 0);
});

test("progress subscriber rejection is awaited and fails the run without unhandled rejection", async () => {
  const agent = new Agent({
    streamFn: fixture([reply([call()], "toolUse")]).streamFn,
    tools: [
      {
        ...echo,
        async execute(_id, _args, _signal, update) {
          update?.({ content: [] });
          await Promise.resolve();
          return { content: [] };
        },
      },
    ],
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_update")
      throw new Error("progress write failed");
  });
  await assert.rejects(agent.prompt("test"), /progress write failed/);
  assert.equal(agent.state.isStreaming, false);
});

test("parallel event sink failure waits for already started tools before returning", async () => {
  const release = deferred();
  const failed = deferred();
  let bDone = false;
  const agent = new Agent({
    toolExecution: "parallel",
    streamFn: fixture([reply([call("a"), call("b")], "toolUse")]).streamFn,
    tools: [
      {
        ...echo,
        async execute(id) {
          if (id === "b") {
            await release.promise;
            bDone = true;
          }
          return { content: [] };
        },
      },
    ],
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolCallId === "a") {
      failed.resolve();
      throw new Error("save failed");
    }
  });
  const run = assert.rejects(agent.prompt("test"), /save failed/);
  await failed.promise;
  assert.equal(agent.state.isStreaming, true);
  release.resolve();
  await run;
  assert.equal(bDone, true);
  assert.equal(agent.state.isStreaming, false);
});

test("prepareRequest then transformContext then convertToLlm runs at request boundary", async () => {
  const order: string[] = [];
  const f = fixture([reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    prepareRequest(context) {
      order.push("prepare");
      assert.equal(context.messages.at(-1)?.role, "user");
    },
    transformContext(messages) {
      order.push("transform");
      return [
        { role: "system", content: "knowledge", timestamp: 0 },
        ...messages,
      ];
    },
    convertToLlm(messages) {
      order.push("convert");
      return messages;
    },
  });
  await agent.prompt("test");
  assert.deepEqual(order, ["prepare", "transform", "convert"]);
  assert.equal(f.requests[0]!.messages[0]?.role, "system");
  assert.equal(agent.state.messages[0]?.role, "user");
});

test("argument preparation cannot mutate the saved model request", async () => {
  const args = { value: "original" };
  const f = fixture([reply([call("one", "echo", args)], "toolUse"), reply()]);
  const agent = new Agent({
    streamFn: f.streamFn,
    tools: [
      {
        ...echo,
        prepareArguments(value) {
          (value as { value: string }).value = "prepared";
          return value;
        },
      },
    ],
  });
  await agent.prompt("test");
  const assistant = agent.state.messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant?.content, [
    call("one", "echo", { value: "original" }),
  ]);
  assert.deepEqual(
    agent.state.messages.find((m) => m.role === "toolResult")?.content,
    [text("prepared")],
  );
});

test("low-level loop does not mutate caller history and validates configuration", async () => {
  const messages = [
    { role: "user" as const, content: [text("input")], timestamp: 0 },
  ];
  await runAgentLoop(
    [],
    { messages },
    {},
    () => {},
    undefined,
    fixture([reply()]).streamFn,
  );
  assert.equal(messages.length, 1);
  await assert.rejects(
    runAgentLoop(
      [],
      { messages },
      { maxTurns: 0 },
      () => {},
      undefined,
      fixture([]).streamFn,
    ),
    /maxTurns/,
  );
  await assert.rejects(
    runAgentLoop(
      [],
      { messages, tools: [echo, echo] },
      {},
      () => {},
      undefined,
      fixture([]).streamFn,
    ),
    /unique/,
  );
});

test("restored chat history is model context and never re-emitted as a fresh assistant reply", async () => {
  const f = fixture([reply([text("new answer")])]);
  const { agent, events } = harness({
    streamFn: f.streamFn,
    messages: [
      { role: "user", content: [text("old question")], timestamp: 1 },
      { ...reply([text("old answer")]), timestamp: 2 },
      { role: "user", content: [text("follow-up")], timestamp: 3 },
    ],
  });
  await agent.continue();
  assert.equal(f.requests[0]!.messages.length, 3);
  const ended = events.filter((e) => e.type === "message_end");
  assert.equal(ended.length, 1);
  assert.ok(ended[0]?.type === "message_end");
  assert.deepEqual(ended[0].message.content, [text("new answer")]);
});
