import { Agent, type AgentTool, type StreamFn } from "../src/runtime/index.js";

// This is a deterministic model fixture, not a real AI or browser test.
const streamFn: StreamFn = async function* ({ messages }) {
  const hasResult = messages.some((m) => m.role === "toolResult");
  yield {
    type: "done",
    message: {
      role: "assistant",
      timestamp: Date.now(),
      stopReason: hasResult ? "stop" : "toolUse",
      content: hasResult
        ? [
            {
              type: "text",
              text: "已查询到两个可复用节点：登录、发送消息。离线循环演示完成。",
            },
          ]
        : [
            {
              type: "toolCall",
              id: "search-1",
              name: "find_nodes",
              arguments: { query: "对话平台" },
            },
          ],
    },
  };
};
const findNodes: AgentTool<{ query: string }> = {
  name: "find_nodes",
  description: "Search the demo reusable-node catalog.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(_id, { query }) {
    return {
      content: [{ type: "text", text: `${query}: login@1, send_message@1` }],
    };
  },
};
const agent = new Agent({
  streamFn,
  tools: [findNodes],
  systemPrompt: "你是测试流程规划助手。",
});
agent.subscribe((event) => {
  console.log(event.type);
  if (event.type === "message_end" && event.message.role === "assistant") {
    for (const block of event.message.content)
      if (block.type === "text") console.log(block.text);
  }
});
await agent.prompt("查找对话平台可复用的测试节点");
if (agent.state.lastEndReason !== "completed") process.exitCode = 1;
