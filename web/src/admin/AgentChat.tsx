import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bubble, Conversations, Sender } from "@ant-design/x";
import {
  App,
  Alert,
  Button,
  Drawer,
  Empty,
  Image,
  Input,
  Modal,
  Pagination,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  Bot,
  CheckCheck,
  History,
  Paperclip,
  Plus,
  Radio,
  Send,
  Square,
  UserRound,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, date, Failure, Heading, Status } from "./client";
import "./chat.css";
const active = (run: any) => run && ["queued", "running"].includes(run.status);
const phaseNames: Record<string, string> = {
  understanding: "理解需求",
  investigating: "调查目标页面",
  inspecting: "查看页面元素",
  planning: "规划测试",
  generating: "生成共享节点",
  composing: "编排流程",
  testing: "运行测试",
};
const toolNames: Record<string, string> = {
  browser_inspect: "查看页面元素",
  browser_action: "操作真实浏览器",
  list_nodes: "查找可复用节点",
  save_node: "保存节点",
  finish_flow: "保存测试流程",
  read_attachment: "读取测试文件",
  report_progress: "更新进度",
};
function Attachment({ file }: { file: any }) {
  return file.mime_type.startsWith("image/") ? (
    <div className="chat-attachment">
      <Image
        width={140}
        src={`/api/chat/attachments/${file.id}`}
        alt={file.name}
      />
      <small>{file.name}</small>
    </div>
  ) : (
    <a
      className="chat-file"
      href={`/api/chat/attachments/${file.id}`}
      target="_blank"
      rel="noreferrer"
    >
      <Paperclip size={14} />
      {file.name} · {Math.ceil(file.size / 1024)} KB
    </a>
  );
}
export default function AgentChat({
  pid,
  eid,
  workspace,
}: {
  pid: string;
  eid: string;
  workspace: any;
}) {
  const [params, setParams] = useSearchParams(),
    sid = params.get("chat") || "";
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [draft, setDraft] = useState(""),
    [files, setFiles] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [events, setEvents] = useState<any[]>([]),
    [connection, setConnection] = useState(""),
    [page, setPage] = useState(1),
    [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false);
  const [drawer, setDrawer] = useState<"history" | "status" | null>(null),
    [rename, setRename] = useState<any>(null),
    [name, setName] = useState(""),
    [olderBusy, setOlderBusy] = useState(false);
  const uploadLock = useRef(false),
    hydrated = useRef(""),
    draftKey = useRef(""),
    createdSession = useRef("");
  const eventScroll = useRef<HTMLDivElement>(null);
  const followEvents = useRef(true);
  const creating = useRef<Promise<string> | null>(null),
    currentSid = useRef(sid),
    outbox = useRef<{ signature: string; id: string } | null>(null);
  const env = workspace.environments.find((e: any) => e.id === eid),
    canEdit =
      workspace.role !== "viewer" &&
      !workspace.project.archived_at &&
      !!env &&
      !env.archived_at;
  const listKey = ["chat-list", pid, eid, page, query, archived];
  const sessions = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api(
        `/projects/${pid}/chat/sessions?environmentId=${eid}&page=${page}&q=${encodeURIComponent(query)}&archived=${archived}`,
      ),
    enabled: !!eid,
  });
  const conversation = useQuery({
    queryKey: ["chat", sid],
    queryFn: async () => {
      const next = await api(`/chat/sessions/${sid}`);
      const old = cache.getQueryData<any>(["chat", sid]);
      const prefix =
        old?.messages?.filter(
          (m: any) => Number(m.seq) < Number(next.messages[0]?.seq || 0),
        ) || [];
      return prefix.length
        ? {
            ...next,
            messages: [...prefix, ...next.messages],
            hasOlder: old.hasOlder,
            artifacts: [
              ...(old.artifacts || []).filter(
                (a: any) => !next.artifacts.some((b: any) => a.id === b.id),
              ),
              ...next.artifacts,
            ],
          }
        : next;
    },
    enabled: !!sid,
    staleTime: 0,
    refetchInterval: (query) =>
      active(query.state.data?.runs?.[0]) ? false : 10000,
    refetchIntervalInBackground: false,
  });
  const data = conversation.data,
    run = data?.runs?.[0],
    running = active(run),
    readOnly =
      !canEdit ||
      !!data?.session.archived_at ||
      !!(data && data.session.environment_id !== eid);
  currentSid.current = sid;
  const refreshList = () =>
    cache.invalidateQueries({ queryKey: ["chat-list", pid, eid] });
  const select = (id: string) => {
    setParams({ env: eid, ...(id ? { chat: id } : {}) });
    setDrawer(null);
  };
  useEffect(() => {
    setError(null);
    const key = `looplab-draft:${pid}:${sid || eid}`;
    if (createdSession.current === sid && sid) {
      createdSession.current = "";
      hydrated.current = sid;
      draftKey.current = key;
      return;
    }
    setFiles([]);
    hydrated.current = "";
    outbox.current = null;
    draftKey.current = key;
    setDraft(sessionStorage.getItem(key) || "");
  }, [sid, pid, eid]);
  useEffect(() => {
    if (data && hydrated.current !== sid) {
      hydrated.current = sid;
      setFiles(data.draftAttachments || []);
    }
  }, [data, sid]);
  const changeDraft = (value: string) => {
    setDraft(value);
    if (draftKey.current) sessionStorage.setItem(draftKey.current, value);
  };
  useEffect(() => {
    const element = eventScroll.current;
    if (element && followEvents.current)
      element.scrollTop = element.scrollHeight;
  }, [events, drawer]);
  useEffect(() => {
    if (!sid || !run?.id) {
      setEvents([]);
      setConnection("");
      return;
    }
    let disposed = false,
      cursor = 0;
    setEvents([]);
    followEvents.current = true;
    setConnection("连接中");
    const source = new EventSource(
      `/api/chat/sessions/${sid}/runs/${run.id}/stream`,
    );
    source.onopen = () => {
      if (!disposed) setConnection("实时连接");
    };
    source.onerror = () => {
      if (!disposed) setConnection("连接中断，正在重连");
    };
    source.addEventListener("update", (event) => {
      const payload = JSON.parse((event as MessageEvent).data),
        fresh = payload.events.filter((e: any) => Number(e.id) > cursor);
      cursor = Math.max(cursor, payload.cursor);
      setEvents((previous) =>
        [
          ...previous,
          ...fresh.filter(
            (e: any) => e.kind !== "agent_text" && e.kind !== "agent_message",
          ),
        ].slice(-120),
      );
      const text = fresh.filter((e: any) => e.kind === "agent_text").at(-1)
        ?.data.text;
      cache.setQueryData(["chat", sid], (old: any) =>
        old
          ? {
              ...old,
              runs: old.runs.map((r: any) =>
                r.id === run.id ? payload.run : r,
              ),
              messages: old.messages.map((m: any) =>
                m.run_id === run.id
                  ? {
                      ...m,
                      status: payload.run.status,
                      error: payload.run.error,
                      summary: payload.run.summary,
                      flow_id: payload.run.flow_id,
                      ...(m.role === "assistant" && text !== undefined
                        ? { content: text }
                        : {}),
                    }
                  : m,
              ),
            }
          : old,
      );
    });
    source.addEventListener("forbidden", () => {
      source.close();
      setConnection("无权访问");
      void conversation.refetch();
    });
    source.addEventListener("done", () => {
      source.close();
      setConnection("已同步");
      void cache.invalidateQueries({ queryKey: ["chat", sid] });
      void refreshList();
      void cache.invalidateQueries({ queryKey: ["resources", pid] });
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [sid, run?.id, cache]);
  async function ensureSession() {
    if (currentSid.current) return currentSid.current;
    if (!creating.current)
      creating.current = api(`/projects/${pid}/chat/sessions`, "POST", {
        environmentId: eid,
      })
        .then((s) => {
          currentSid.current = s.id;
          createdSession.current = s.id;
          select(s.id);
          void refreshList();
          return s.id;
        })
        .finally(() => {
          creating.current = null;
        });
    return creating.current;
  }
  async function upload(incoming: File[]) {
    if (readOnly || uploadLock.current || busy) return;
    if (files.length + incoming.length > 5) {
      message.error("每条消息最多 5 个附件");
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setError(null);
    try {
      const id = await ensureSession();

      for (const file of incoming) {
        if (file.size > 5 * 1024 * 1024)
          throw new Error(`${file.name} 超过 5 MB`);
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const attachment = await api(
          `/chat/sessions/${id}/attachments`,
          "POST",
          { name: file.name, data: encoded },
        );
        setFiles((old) => [...old, attachment]);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  }
  async function send() {
    if (
      readOnly ||
      running ||
      busy ||
      uploading ||
      (!draft.trim() && !files.length)
    )
      return;
    setBusy(true);
    setError(null);
    const text = draft,
      ids = files.map((f) => f.id),
      signature = JSON.stringify([text, ids]);
    if (outbox.current?.signature !== signature)
      outbox.current = { signature, id: crypto.randomUUID() };
    try {
      const clientId = outbox.current!.id;
      const id = await ensureSession();
      await api(`/chat/sessions/${id}/messages`, "POST", {
        text,
        attachmentIds: ids,
        clientId,
      });
      setDraft("");
      setFiles([]);
      outbox.current = null;
      sessionStorage.removeItem(`looplab-draft:${pid}:${id}`);
      sessionStorage.removeItem(`looplab-draft:${pid}:${eid}`);
      await cache.invalidateQueries({ queryKey: ["chat", id] });
      void refreshList();
    } catch (e) {
      setDraft(text);
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    try {
      await api(`/chat/sessions/${sid}/runs/${run.id}/cancel`, "POST");
      await conversation.refetch();
    } catch (e) {
      setError(e as Error);
    }
  }
  async function updateSession(id: string, body: any) {
    try {
      await api(`/chat/sessions/${id}`, "PATCH", body);
      setRename(null);
      await refreshList();
      if (id === sid) await conversation.refetch();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const history = (
    <div className="chat-history-inner">
      <Button
        type="primary"
        block
        icon={<Plus size={16} />}
        disabled={!canEdit || busy || uploading}
        onClick={() => select("")}
      >
        新对话
      </Button>
      <Input.Search
        placeholder="搜索会话"
        allowClear
        onSearch={(v) => {
          setQuery(v);
          setPage(1);
        }}
      />
      <Segmented
        block
        size="small"
        options={["全部会话", "已归档"]}
        value={archived ? "已归档" : "全部会话"}
        onChange={(v) => {
          setArchived(v === "已归档");
          setPage(1);
        }}
      />
      <Failure error={sessions.error} />
      {sessions.isPending && eid ? (
        <Spin />
      ) : (
        <Conversations
          activeKey={sid}
          items={(sessions.data?.items || []).map((s: any) => ({
            key: s.id,
            label: s.title,
            tooltip: s.title,
          }))}
          onActiveChange={(key) => {
            if (!busy && !uploading) select(String(key));
          }}
          menu={
            canEdit
              ? (item) => ({
                  items: [
                    { key: "rename", label: "重命名" },
                    {
                      key: "archive",
                      label: archived ? "恢复会话" : "归档会话",
                      disabled: item.key === sid && running,
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === "rename") {
                      setRename(item);
                      setName(String(item.label));
                    } else
                      void updateSession(String(item.key), {
                        archived: !archived,
                      });
                  },
                })
              : undefined
          }
        />
      )}
      {sessions.data?.total === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
      )}
      <Pagination
        simple
        hideOnSinglePage
        size="small"
        current={page}
        pageSize={30}
        total={sessions.data?.total || 0}
        onChange={setPage}
      />
      <p className="chat-muted">
        会话与附件在项目内共享，执行环境固定为「{env?.name || "未选择"}」。
      </p>
    </div>
  );
  const phase = events.filter((e) => e.kind === "agent_status").at(-1)?.data;
  const visibleEvents = events.filter(
    (e) =>
      e.data.name !== "report_progress" &&
      [
        "agent_status",
        "agent_tool_start",
        "agent_tool_end",
        "node_saved",
        "flow_saved",
        "node_passed",
        "step",
        "run_passed",
        "run_failed",
        "conversation_completed",
      ].includes(e.kind),
  );
  const statusPanel = (
    <div className="chat-status-inner">
      <div className="chat-panel-title">
        <Radio size={17} />
        <b>执行动态</b>
        {run && <Status value={run.status} />}
      </div>
      <p className="chat-muted">
        {connection || "发送消息后，实时展示调查与执行过程。"}
      </p>
      {run && (
        <div className="chat-current">
          <strong>
            {running
              ? phaseNames[phase?.stage] ||
                (run.status === "queued" ? "排队等待执行" : "Agent 正在处理")
              : run.status === "passed"
                ? "测试验证通过"
                : run.status === "completed"
                  ? "Agent 已回复"
                  : run.status === "cancelled"
                    ? "本轮已停止"
                    : "本轮执行失败"}
          </strong>
          <p>{running ? phase?.message : run.summary || run.error}</p>
          {run.cancel_requested && running && (
            <Tag color="warning">正在停止…</Tag>
          )}
        </div>
      )}
      <div
        className="chat-events"
        aria-live="polite"
        ref={eventScroll}
        onScroll={(e) => {
          const element = e.currentTarget;
          followEvents.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            40;
        }}
      >
        {visibleEvents.map((e) => (
          <div className="chat-event" key={e.id}>
            <span
              className={
                e.kind.includes("failed") ||
                e.data.isError ||
                e.data.status === "failed"
                  ? "event-dot failed"
                  : "event-dot"
              }
            />
            <div>
              <strong>
                {e.kind === "agent_status"
                  ? phaseNames[e.data.stage] || "进度"
                  : e.kind === "agent_tool_start"
                    ? toolNames[e.data.name] || e.data.name
                    : e.kind === "agent_tool_end"
                      ? e.data.isError
                        ? "工具执行失败"
                        : `${toolNames[e.data.name] || e.data.name}完成`
                      : (
                          {
                            node_saved: "共享节点已保存",
                            flow_saved: "流程已保存",
                            node_passed: "节点验证通过",
                            step:
                              e.data.status === "passed"
                                ? "步骤验证通过"
                                : e.data.status === "failed"
                                  ? "步骤验证失败"
                                  : "正在执行步骤",
                            run_passed: "测试通过",
                            run_failed: "执行结束",
                            conversation_completed: "回复完成",
                          } as any
                        )[e.kind]}
              </strong>
              {e.kind === "agent_status" && <p>{e.data.message}</p>}
              {e.kind === "node_saved" && <p>{e.data.name || e.data.key}</p>}
              <small>
                {new Date(e.created_at).toLocaleTimeString("zh-CN")}
              </small>
            </div>
          </div>
        ))}
      </div>
      {run && (
        <Space wrap>
          <Link to={`/projects/${pid}/runs?env=${eid}&run=${run.id}`}>
            完整运行记录
          </Link>
          {run.flow_id && (
            <>
              <Link to={`/projects/${pid}/flows?env=${eid}`}>查看流程</Link>
              <a
                href={`/api/projects/${pid}/flows/${run.flow_id}/export`}
                target="_blank"
                rel="noreferrer"
              >
                导出脚本
              </a>
            </>
          )}
        </Space>
      )}
      {(data?.artifacts || [])
        .filter(
          (a: any) => a.run_id === run?.id && a.mime_type.startsWith("image/"),
        )
        .map((a: any) => (
          <div className="chat-result-image" key={a.id}>
            <Image width="100%" src={`/api/artifacts/${a.id}`} alt={a.name} />
            <small>{a.name}</small>
          </div>
        ))}
    </div>
  );
  const messages = (data?.messages || []).map((m: any) => ({
    key: m.id,
    role: m.role === "user" ? "user" : "ai",
    placement: m.role === "user" ? ("end" as const) : ("start" as const),
    variant: m.role === "user" ? ("filled" as const) : ("borderless" as const),
    avatar: m.role === "user" ? <UserRound size={19} /> : <Bot size={20} />,
    header: (
      <span>
        {m.role === "user" ? m.author_name || "用户" : "LoopLab Agent"}{" "}
        <small>{date(m.created_at)}</small>
      </span>
    ),
    loading:
      m.role === "assistant" && !m.content && active({ status: m.status }),
    content: (
      <div className="chat-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
            img: ({ alt }) => <span>[图片：{alt}]</span>,
          }}
        >
          {m.content ||
            (m.role === "assistant"
              ? "本轮没有文本回复，请查看执行状态。"
              : "")}
        </Markdown>
        <Space wrap>
          {m.attachments?.map((f: any) => (
            <Attachment key={f.id} file={f} />
          ))}
        </Space>
      </div>
    ),
    footer:
      m.role === "assistant" ? (
        <Space wrap>
          <Status value={m.status} />
          {m.flow_id && (
            <Tag icon={<CheckCheck size={13} />}>已保存测试流程</Tag>
          )}
          <Link to={`/projects/${pid}/runs?env=${eid}&run=${m.run_id}`}>
            查看记录
          </Link>
        </Space>
      ) : undefined,
  }));
  return (
    <>
      <Heading
        title="Agent 对话"
        note="描述目标、上传测试文件或页面截图，让 Agent 调查、编排并验证测试。"
        actions={
          <Space>
            <Button
              className="chat-history-toggle"
              icon={<History size={16} />}
              onClick={() => setDrawer("history")}
            >
              会话
            </Button>
            <Button
              className="chat-status-toggle"
              icon={<Radio size={16} />}
              onClick={() => setDrawer("status")}
            >
              执行动态
            </Button>
          </Space>
        }
      />
      {!eid ? (
        <Alert type="info" showIcon title="请先创建并选择环境，再开始对话。" />
      ) : (
        <div className="chat-workspace">
          <aside className="chat-history">{history}</aside>
          <main
            className="chat-main"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(Array.from(e.dataTransfer.files));
            }}
          >
            <div className="chat-conversation-title">
              <b>{data?.session.title || "开始一次新的测试探索"}</b>
              <Tag>{data?.session.environment_name || env?.name}</Tag>
            </div>
            <Failure
              error={conversation.error}
              retry={() => void conversation.refetch()}
            />
            {data && data.session.environment_id !== eid && (
              <Alert
                type="error"
                title="此会话属于其他环境。请从会话列表打开当前环境的对话。"
              />
            )}
            {data?.session.archived_at && (
              <Alert
                title="此会话已归档，恢复后可以继续对话。"
                action={
                  canEdit && (
                    <Button
                      onClick={() =>
                        void updateSession(sid, { archived: false })
                      }
                    >
                      恢复
                    </Button>
                  )
                }
              />
            )}
            {sid && conversation.isPending ? (
              <Spin />
            ) : messages.length ? (
              <>
                {data.hasOlder && (
                  <Button
                    size="small"
                    type="text"
                    loading={olderBusy}
                    onClick={async () => {
                      setOlderBusy(true);
                      try {
                        const older = await api(
                          `/chat/sessions/${sid}?before=${data.messages[0].seq}`,
                        );
                        cache.setQueryData(["chat", sid], (old: any) => ({
                          ...old,
                          messages: [...older.messages, ...old.messages],
                          hasOlder: older.hasOlder,
                        }));
                      } catch (e) {
                        setError(e as Error);
                      } finally {
                        setOlderBusy(false);
                      }
                    }}
                  >
                    加载更早的消息
                  </Button>
                )}
                <Bubble.List
                  className="chat-bubbles"
                  items={messages}
                  autoScroll
                />
              </>
            ) : (
              <div className="chat-welcome">
                <div className="chat-bot-mark">
                  <Bot size={32} />
                </div>
                <Typography.Title level={3}>
                  从一个目标，开始一条测试流程
                </Typography.Title>
                <p>
                  我会结合项目知识、已有节点和当前页面，生成可重复执行的流程，并在真实浏览器中验证。
                </p>
                <div className="chat-suggestions">
                  {(data?.session.repair_node_id
                    ? ["请调查并修复这个节点，复用其他步骤后验证流程。"]
                    : data?.session && !data.session.is_draft
                      ? [
                          `请根据测试用例「${data.session.case_title}」生成并验证流程。`,
                        ]
                      : [
                          "检查当前平台是否具备最小可用性，先调查页面再生成测试流程。",
                          "先查看项目知识和已有节点，帮我梳理适合测试的关键路径。",
                        ]
                  ).map((text) => (
                    <Button
                      block
                      key={text}
                      disabled={readOnly}
                      onClick={() => changeDraft(text)}
                    >
                      {text}
                    </Button>
                  ))}
                </div>
                <p className="chat-muted">
                  也可以先讨论需求，或拖入测试文件 / 截图。
                </p>
              </div>
            )}
            <div className="chat-composer">
              <Failure error={error} />
              {files.length > 0 && (
                <div className="chat-pending-files">
                  {files.map((f) => (
                    <Tag
                      key={f.id}
                      closable={!busy && !uploading}
                      onClose={(e) => {
                        e.preventDefault();
                        void api(
                          `/chat/sessions/${sid}/attachments/${f.id}`,
                          "DELETE",
                        )
                          .then(() =>
                            setFiles((old) => old.filter((x) => x.id !== f.id)),
                          )
                          .catch((e) => setError(e));
                      }}
                    >
                      {f.name}
                    </Tag>
                  ))}
                </div>
              )}
              <Sender
                value={draft}
                onChange={changeDraft}
                placeholder={
                  readOnly ? "当前会话只读" : "描述测试目标，或继续讨论与修改…"
                }
                disabled={readOnly}
                autoSize={{ minRows: 2, maxRows: 6 }}
                onSubmit={() => void send()}
                onPasteFile={(list) => void upload(Array.from(list))}
                prefix={
                  <Upload
                    accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.ts,.tsx,.js,.jsx,.feature,.log"
                    showUploadList={false}
                    multiple
                    disabled={readOnly || busy || uploading}
                    beforeUpload={(file, list) => {
                      if (file === list[0]) void upload(list);
                      return false;
                    }}
                  >
                    <Button
                      aria-label="添加附件"
                      type="text"
                      icon={<Paperclip size={18} />}
                      loading={uploading}
                      disabled={readOnly || busy || uploading}
                    />
                  </Upload>
                }
                suffix={
                  <Space>
                    {running ? (
                      <Button
                        danger
                        icon={<Square size={14} />}
                        onClick={() => void cancel()}
                        disabled={readOnly || run.cancel_requested}
                      >
                        停止执行
                      </Button>
                    ) : (
                      <Button
                        type="primary"
                        aria-label="发送消息"
                        icon={<Send size={16} />}
                        loading={busy}
                        disabled={
                          readOnly ||
                          uploading ||
                          (!draft.trim() && !files.length)
                        }
                        onClick={() => void send()}
                      >
                        发送
                      </Button>
                    )}
                  </Space>
                }
              />
              <div className="chat-composer-note">
                <span>GPT 6 Luna · Responses API</span>
                <span>Enter 发送 · Shift+Enter 换行 · 每个附件 ≤ 5 MB</span>
              </div>
            </div>
          </main>
          <aside className="chat-status">{statusPanel}</aside>
        </div>
      )}
      <Drawer
        title={drawer === "history" ? "项目会话" : "执行动态"}
        open={!!drawer}
        onClose={() => setDrawer(null)}
        size={360}
      >
        {drawer === "history" ? history : statusPanel}
      </Drawer>
      <Modal
        title="重命名会话"
        open={!!rename}
        onCancel={() => setRename(null)}
        onOk={() => void updateSession(String(rename.key), { title: name })}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </Modal>
    </>
  );
}
