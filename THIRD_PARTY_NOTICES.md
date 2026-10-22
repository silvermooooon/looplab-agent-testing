# pi 源码来源与改动记录

本项目包含从 pi Agent 移植并修改的源代码，不是通过 npm 依赖或运行时 import 使用 pi。

- 上游项目：<https://github.com/earendil-works/pi>
- 本次基准提交：`83692682f095528f8b71652ddacff7075e36e893`
- 本地源快照的 `packages/agent/package.json` 版本：`1.0.1`
- 读取来源：用户已有的 `pi-mono` 本地 checkout；读取时工作区没有未提交修改。该提交是移植基准，不宣称是上游最新发布版本。
- 原版权：Copyright (c) 2025 Mario Zechner
- 原许可证：MIT，完整原文保存在 [licenses/pi-MIT.txt](licenses/pi-MIT.txt)。使用、复制或分发所含源代码及其重要部分时保留该声明和许可证。
- 原始文件 SHA-256：见 [docs/pi-source-manifest.json](docs/pi-source-manifest.json)。

## 对应关系

| 上游路径                                            | 本地路径                       | 处理                                                                 |
| --------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `packages/agent/src/agent-loop.ts` 的工具执行部分   | `src/runtime/tool-executor.ts` | 直接移植执行管线并修改类型、参数校验、取消与异常收敛                 |
| `packages/agent/src/agent-loop.ts` 的请求和循环部分 | `src/runtime/agent-loop.ts`    | 根据源代码重新组织，保留工具回填、两类输入队列、流生命周期和终止语义 |
| `packages/agent/src/agent.ts`                       | `src/runtime/agent.ts`         | 参照源码重写状态包装、异步订阅、运行锁、队列和继续执行               |
| `packages/agent/src/types.ts`                       | `src/runtime/types.ts`         | 本地定义消息、工具和事件类型，移除 pi-ai/typebox 类型依赖            |

`validation.ts`、离线示例和行为测试是本项目实现。测试场景参考了上游 `packages/agent/test/agent-loop.test.ts` 的行为范围，并增加了本项目的取消和订阅失败测试；没有引入上游测试运行器或依赖。

## 保留的核心语义

- assistant 请求工具后，执行工具并把结果回填，继续模型循环。
- 参数准备 → JSON Schema 校验 → before hook → 执行 → after hook。
- 串行/并行执行，以及任一 sequential 工具强制串行整个批次。
- 并行完成事件按完成顺序，历史工具结果按原调用顺序。
- 截断响应的工具调用只产生错误结果，不执行副作用。
- 全批次 terminate 才终止工具触发的自动续轮；混合批次继续。
- steering 在工具批次边界注入，follow-up 在自然停止点注入。
- finishTurn 的显式续轮由自然工具/队列续轮满足，不重复产生请求。
- await 事件订阅者；agent_end 监听完成之前保持忙碌状态。

## 本地差异

1. 默认工具执行方式改为 **sequential**，便于浏览器操作；上游基准默认为 parallel。
2. 默认限制 40 轮，并显式返回 `max_turns`。到达上限时保留包装层中的排队输入。
3. 不依赖 pi-ai 的模型注册、provider 协议、事件流类或 API Key 配置。`StreamFn` 采用本地 `AsyncIterable<ModelStreamEvent>` 协议；核心本身不联网。
4. 工具声明由每次请求的 `tools` 字段显式提供，不采用上游 system transcript 的 `toolsAdded/toolsRemoved` 增量声明机制。恢复任务需要另存工具与模型配置。
5. 使用 AJV 严格校验，不进行自动类型转换。准备参数与校验操作使用副本，避免改写模型原始调用记录。
6. 取消后给尚未执行的工具调用补齐错误结果，保持调用/结果配对；不会执行其工具函数。
7. 并行任务采用 `Promise.allSettled` 收敛，避免事件写入失败后任务已返回、工具仍在后台运行。异步进度写入失败会拒绝运行，并立即挂接 rejection 处理。
8. 模型网络异常或无终结事件转为错误消息；订阅者异常直接拒绝调用，不合成第二组终结事件掩盖写入失败。
9. 对外状态和订阅事件提供副本。截断/失败的 partial 内容不作为最终可执行工具调用保存。
10. 类型和协议只覆盖当前测试运行时需要的子集，**不是 pi API 的完整兼容实现**。没有移植 proxy、coding-agent、MCP 装配、动态工具声明、prepareNextTurn、模型用量统计、reasoning 专用事件或会话落盘恢复。

后续合并上游修复时应手动审阅相关源码差异，更新基准与文件摘要，并运行本地行为测试。当前版本的运行、编译和测试不需要原始 pi checkout 存在。
