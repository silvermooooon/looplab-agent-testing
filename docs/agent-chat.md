# Agent 对话入口

## 使用方式

进入项目后选择环境，打开 **Agent 对话**。直接描述目标，或添加测试文件、截图、PDF，再发送消息。也可以先讨论目标，继续补充要求后再生成流程。

测试用例中的“与 Agent 生成”、流程页的“与 Agent 创建流程”、共享节点中的“Agent 修复”均进入同一聊天页面。原来的直接生成/修复弹窗已移除；确定性流程回放仍保留独立按钮。旧 `/runs` API 为已有自动化客户端保留兼容性。

会话创建时固定项目、环境和关联用例。切换顶部环境会退出当前会话；环境列表按环境筛选。无关联用例的会话先使用草稿用例，只有保存流程时才把明确的测试目标转成正式用例。

会话列表支持搜索、分页、重命名、归档、恢复。所有项目成员可读，所有者与编辑者可继续对话；只读成员无法上传或执行。会话、消息和附件存于 PostgreSQL，团队成员共用；未发送附件仅向上传者展示。消息作者单独记录。

## 实时交互

UI 直接使用 [Ant Design X](https://github.com/ant-design/x) 的 `Conversations`、`Bubble.List`、`Sender`，沿用 Ant Design 的上传、图片预览、抽屉和主题。Markdown 使用 react-markdown / remark-gfm，不执行原始 HTML，也不自动加载 Markdown 中的远程图片。

- OpenAI Responses `response.output_text.delta` 驱动可见回复，不展示模型私有推理。
- 模型的工具调用产生实际浏览器、节点和流程事件；`report_progress` 工具可补充简短说明。
- 浏览器调查、页面元素读取、节点保存、流程组合、独立重放都有服务端进度事件。
- SSE 从持久化事件表读取，每 400 ms 检查增量；通过事件 ID 恢复。每批最多 200 条，客户端最多保留 120 条近期动态；完整记录仍可访问。
- 回复约每 150 ms 合并落库，事件携带完整可见文本快照，重连不会重复拼接文字。跨 delta 的凭据片段先暂存，完整凭据脱敏后才输出。
- 任务终态与事件落库完成分别记录，SSE 等最终持久化后才关闭，避免丢掉最后一句和结果。
- 每个会话同一时间只有一个活动任务；消息使用客户端 UUID 幂等，网络重试不会重复创建任务。可停止当前任务后继续对话。
- 普通回答标记为“已回复”，不产生虚假的测试通过。只有全新浏览器完成断言重放后才标记“通过”。

已有消息恢复到 Agent 的初始上下文，再调用 `continue()`；历史 assistant 消息不会作为新消息重新发出或写入当前回复。每轮仍是独立 Worker 任务，页面刷新、浏览器断线不会终止后台执行。

## 附件和上下文边界

支持 PNG/JPEG/WebP 截图、PDF，以及 UTF-8 TXT/Markdown/CSV/JSON/YAML/TS/JS/Feature/Log 文本文件。通过扩展名与签名校验；不支持 SVG、Office 文件、压缩包或任意二进制文件。上传的代码只作为测试资料读取，不执行。

- 单附件最大 5 MB，文本最大 200 KB；单条消息最多 5 个附件、合计 12 MB。
- 单会话累计最多 50 MB / 100 个附件。
- 图片通过 `input_image`、PDF 通过 `input_file` 直接送入 Responses API；文本按内容送入，长文件可通过 `read_attachment` 分页读取。
- 模型保留最近 40 条消息，文本上下文预算 120,000 字符、二进制附件 12 MB；较新消息优先。长期记忆摘要、向量检索尚未实现。
- UI 每次读取最近 50 条消息，按需加载更早内容。会话列表每页 30 条。
- 活动任务使用 SSE；空闲会话每 10 秒检查团队新消息，隐藏标签页停止周期请求。普通管理列表原有按需加载策略不变。

仍沿用现有浏览器边界：单 origin、顺序节点、常规 DOM 操作；不支持验证码/MFA、跨域 SSO 或视觉坐标操作。上传截图可用于理解测试目标，并不等同于坐标驱动浏览器。

## 验证

```bash
npm test
npm run build
npm run verify:management
npm run verify:chat
```

`verify:chat` 需要本地服务和 `/demo` 已开启，使用 `test:acceptance` 生成的 `.data/acceptance-credentials.json` 登录，在独立项目执行真实 GPT 6 Luna 请求，会消耗 API 配额。结果和截图保存在被 Git 忽略的 `.data/chat-acceptance-result.json` 与 `.data/screenshots/chat/`。

2026-10-22 本地验收覆盖 11 组：

1. UI 同时上传 Markdown、截图、PDF；未发送附件刷新恢复。
2. 真实模型读取三类附件、增量回复，资料确认不触发测试。
3. 消息幂等与同会话并发拒绝。
4. 多轮聊天生成独立节点与流程，Chrome 全新会话重放通过并截图。
5. SSE 游标恢复不重放旧事件，终态事件完整。
6. 第二位编辑者共享会话和资产，导出 TypeScript 成功。
7. 后续改动测试参数，新流程复用完全相同的节点版本。
8. 用例生成统一跳转到聊天页。
9. 归档、只读成员和跨项目附件访问的权限校验。
10. 取消对话任务。
11. 390px 移动端抽屉，无横向溢出、无浏览器运行异常。

另有 45 项离线行为测试，以及 11 组原管理 UI 回归。聊天页面独立懒加载块约 280 KB（gzip 90 KB），未进入聊天页不会请求该块；Brotli/gzip 预压缩仍启用。公共 App 块仍约 668 KB（gzip 222 KB），构建保留大小告警。这些是本地功能验收与构建测量，尚未做生产并发负载测试。

Responses 输入与事件实现参考：[流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)、[图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[文件输入](https://developers.openai.com/api/docs/guides/file-inputs)。
