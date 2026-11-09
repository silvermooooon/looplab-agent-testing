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
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import {
  Bot,
  CheckCheck,
  FolderOpen,
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
import BrowserPreview, { describeBrowserAction } from "./BrowserPreview";
import { useIntervention } from "./Intervention";
import "./chat.css";
const active = (run: any) => run && ["queued", "running"].includes(run.status);
type PendingMessage = {
  sid: string;
  message: {
    client_id: string;
    author_id?: string;
    author_name?: string;
    content: string;
    role: "user";
    created_at: string;
    attachments: any[];
    libraryFiles: any[];
    sending: true;
  };
};
function fileSelectionError(files: Array<{ size: number }>) {
  if (files.length > 5) return "每条消息的附件和测试文件合计最多 5 个";
  if (
    files.reduce((total, file) => total + Number(file.size), 0) >
    12 * 1024 * 1024
  )
    return "每条消息的附件和测试文件合计不能超过 12 MiB";
  return "";
}
function readLibraryDraft(key: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}
const phaseNames: Record<string, string> = {
  understanding: "理解需求",
  investigating: "调查目标页面",
  inspecting: "查看页面元素",
  planning: "规划测试",
  generating: "生成共享节点",
  composing: "编排流程",
  testing: "运行测试",
  human: "等待人工处理",
  knowledge: "处理项目知识",
};
const toolNames: Record<string, string> = {
  browser_inspect: "查看页面元素",
  browser_action: "操作真实浏览器",
  list_nodes: "查找可复用节点",
  save_node: "保存节点",
  finish_flow: "保存测试流程",
  read_attachment: "读取测试文件",
  list_test_files: "查找项目测试文件",
  read_test_file: "读取项目测试文件",
  list_knowledge: "查找项目知识",
  read_knowledge: "读取知识文档",
  save_knowledge: "保存知识文档",
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
  model,
}: {
  pid: string;
  eid: string;
  workspace: any;
  model: string;
}) {
  const [params, setParams] = useSearchParams(),
    sid = params.get("chat") || "";
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [draft, setDraft] = useState(""),
    [files, setFiles] = useState<any[]>([]),
    [libraryFiles, setLibraryFiles] = useState<any[]>(() =>
      readLibraryDraft(`looplab-file-draft:${pid}:${sid || eid}`),
    ),
    [busy, setBusy] = useState(false),
    [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null),
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
  const [filePicker, setFilePicker] = useState(false),
    [filePage, setFilePage] = useState(1),
    [fileSearch, setFileSearch] = useState(""),
    [fileSelection, setFileSelection] = useState<Record<string, any>>({});
  const uploadLock = useRef(false),
    sendLock = useRef(false),
    mounted = useRef(true),
    hydrated = useRef(""),
    draftKey = useRef(""),
    fileDraftKey = useRef(""),
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
  const libraryFileId = params.get("file") || "";
  const libraryFile = useQuery({
    queryKey: ["project-file", pid, libraryFileId],
    queryFn: ({ signal }) =>
      api(`/projects/${pid}/files/${libraryFileId}`, "GET", undefined, signal),
    enabled: !!libraryFileId,
    retry: false,
  });
  const fileOptions = useQuery({
    queryKey: ["project-files", pid, filePage, fileSearch, false],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/files?page=${filePage}&pageSize=20&q=${encodeURIComponent(fileSearch)}&archived=false`,
        "GET",
        undefined,
        signal,
      ),
    enabled: filePicker,
  });
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
    queryFn: async ({ signal }) => {
      const next = await api(`/chat/sessions/${sid}`, "GET", undefined, signal);
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
  const intervention = useIntervention(run?.id, !!running);
  currentSid.current = sid;
  const refreshList = () =>
    cache.invalidateQueries({ queryKey: ["chat-list", pid, eid] });
  const select = (id: string) => {
    setParams({ env: eid, ...(id ? { chat: id } : {}) });
    setDrawer(null);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setError(null);
    const key = `looplab-draft:${pid}:${sid || eid}`;
    const fileKey = `looplab-file-draft:${pid}:${sid || eid}`;
    if (createdSession.current === sid && sid) {
      createdSession.current = "";
      hydrated.current = sid;
      if (draftKey.current && draftKey.current !== key) {
        const saved = sessionStorage.getItem(draftKey.current);
        if (saved) sessionStorage.setItem(key, saved);
        sessionStorage.removeItem(draftKey.current);
      }
      draftKey.current = key;
      if (fileDraftKey.current && fileDraftKey.current !== fileKey) {
        const saved = sessionStorage.getItem(fileDraftKey.current);
        if (saved) sessionStorage.setItem(fileKey, saved);
        sessionStorage.removeItem(fileDraftKey.current);
      }
      fileDraftKey.current = fileKey;
      return;
    }
    setFiles([]);
    setLibraryFiles(readLibraryDraft(fileKey));
    hydrated.current = "";
    outbox.current = null;
    draftKey.current = key;
    fileDraftKey.current = fileKey;
    setDraft(sessionStorage.getItem(key) || "");
  }, [sid, pid, eid]);
  function changeLibraryFiles(next: any[]) {
    setLibraryFiles(next);
    if (fileDraftKey.current) {
      if (next.length)
        sessionStorage.setItem(
          fileDraftKey.current,
          JSON.stringify(
            next.map(({ id, name, size, mime_type, archived_at }) => ({
              id,
              name,
              size,
              mime_type,
              archived_at,
            })),
          ),
        );
      else sessionStorage.removeItem(fileDraftKey.current);
    }
  }
  useEffect(() => {
    if (!libraryFileId || (!libraryFile.data && !libraryFile.error)) return;
    if (libraryFile.data && !libraryFile.data.archived_at) {
      const nextFiles = libraryFiles.some(
        (item) => item.id === libraryFile.data.id,
      )
        ? libraryFiles
        : [...libraryFiles, libraryFile.data];
      const problem = fileSelectionError([...files, ...nextFiles]);
      if (problem) setError(new Error(problem));
      else changeLibraryFiles(nextFiles);
    } else {
      setError(libraryFile.error || new Error("该测试文件已归档"));
    }
    const next = new URLSearchParams(params);
    next.delete("file");
    setParams(next, { replace: true });
  }, [
    libraryFileId,
    libraryFile.data,
    libraryFile.error,
    params,
    setParams,
    files,
    libraryFiles,
  ]);
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
          cache.setQueryData(["chat", s.id], {
            session: { ...s, is_draft: true, environment_name: env?.name },
            messages: [],
            runs: [],
            artifacts: [],
            draftAttachments: [],
            hasOlder: false,
          });
          if (mounted.current && !currentSid.current) {
            currentSid.current = s.id;
            createdSession.current = s.id;
            setPendingMessage((pending) =>
              pending && !pending.sid ? { ...pending, sid: s.id } : pending,
            );
            select(s.id);
          }
          void refreshList();
          return s.id;
        })
        .finally(() => {
          creating.current = null;
        });
    return creating.current;
  }
  async function upload(incoming: File[]) {
    if (readOnly || uploadLock.current || sendLock.current) return;
    const problem = fileSelectionError([
      ...files,
      ...libraryFiles,
      ...incoming,
    ]);
    if (problem) {
      message.error(problem);
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
      sendLock.current ||
      uploading ||
      (!draft.trim() && !files.length && !libraryFiles.length)
    )
      return;
    const problem = fileSelectionError([...files, ...libraryFiles]);
    if (problem) {
      setError(new Error(problem));
      return;
    }
    sendLock.current = true;
    setBusy(true);
    setError(null);
    const text = draft,
      ids = files.map((f) => f.id),
      testFileIds = libraryFiles.map((file) => file.id),
      signature = JSON.stringify([text, ids, testFileIds]);
    if (outbox.current?.signature !== signature)
      outbox.current = { signature, id: crypto.randomUUID() };
    const clientId = outbox.current.id;
    const previousSid = currentSid.current;
    const author = cache.getQueryData<{ user: { id: string; name: string } }>([
      "session",
    ])?.user;
    let id = previousSid;
    setPendingMessage({
      sid: previousSid,
      message: {
        client_id: clientId,
        author_id: author?.id,
        author_name: author?.name,
        content: text.trim(),
        role: "user",
        created_at: new Date().toISOString(),
        attachments: files,
        libraryFiles,
        sending: true,
      },
    });
    setDraft("");
    setFiles([]);
    setLibraryFiles([]);
    try {
      id = await ensureSession();
      const accepted = await api(`/chat/sessions/${id}/messages`, "POST", {
        text,
        attachmentIds: ids,
        testFileIds,
        clientId,
      });
      outbox.current = null;
      sessionStorage.removeItem(`looplab-draft:${pid}:${id}`);
      sessionStorage.removeItem(`looplab-file-draft:${pid}:${id}`);
      if (!previousSid) {
        sessionStorage.removeItem(`looplab-draft:${pid}:${eid}`);
        sessionStorage.removeItem(`looplab-file-draft:${pid}:${eid}`);
      }
      const chatKey = ["chat", id];
      await cache.cancelQueries({ queryKey: chatKey, exact: true });
      if (accepted.run && cache.getQueryData(chatKey)) {
        cache.setQueryData(chatKey, (old: any) => {
          if (old.messages.some((m: any) => m.run_id === accepted.runId))
            return old;
          return {
            ...old,
            session: { ...old.session, ...accepted.session },
            messages: [
              ...old.messages,
              ...accepted.messages.map((m: any) => ({
                ...m,
                status: accepted.run.status,
                attachments: m.role === "user" ? files : [],
                libraryFiles: m.role === "user" ? libraryFiles : [],
              })),
            ],
            runs: [accepted.run, ...old.runs].slice(0, 25),
            draftAttachments: old.draftAttachments.filter(
              (file: any) => !ids.includes(file.id),
            ),
          };
        });
      } else {
        await cache.invalidateQueries({ queryKey: chatKey, exact: true });
      }
      void refreshList();
    } catch (e) {
      if (
        mounted.current &&
        (currentSid.current === id || (!previousSid && !currentSid.current))
      ) {
        setDraft(text);
        setFiles(files);
        setLibraryFiles(libraryFiles);
        setError(e as Error);
      }
    } finally {
      setPendingMessage(null);
      sendLock.current = false;
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
        "knowledge_loaded",
        "knowledge_saved",
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
        <div
          className={
            run.status === "failed"
              ? "chat-current chat-current-failed"
              : "chat-current"
          }
        >
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
          <p>
            {running
              ? phase?.message
              : run.status === "failed"
                ? run.error || run.summary
                : run.summary || run.error}
          </p>
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
                            knowledge_loaded: "已加载项目知识",
                            knowledge_saved:
                              e.data.action === "updated"
                                ? "已更新知识文档"
                                : "已新增知识文档",
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
              {e.kind === "agent_tool_start" &&
                e.data.name === "browser_action" &&
                e.data.args?.step?.action && (
                  <p>
                    {describeBrowserAction(
                      e.data.args.step.action,
                      e.data.args.step.selector,
                    )}
                  </p>
                )}
              {e.kind === "step" && e.data.status === "start" && (
                <p>
                  {describeBrowserAction(
                    e.data.step?.action,
                    e.data.step?.selector,
                  )}
                </p>
              )}
              {e.kind === "node_saved" && <p>{e.data.name || e.data.key}</p>}
              {e.kind === "knowledge_loaded" && (
                <p>
                  本轮载入 {e.data.count} 份文档。
                  {e.data.hasMore && "Agent 可查阅其余文档或完整内容。"}
                </p>
              )}
              {e.kind === "knowledge_saved" && (
                <p>
                  <Link
                    to={`/projects/${pid}/knowledge?env=${eid}&q=${encodeURIComponent(e.data.title)}`}
                  >
                    {e.data.title}
                  </Link>
                </p>
              )}
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
  const pending =
    pendingMessage &&
    (pendingMessage.sid === sid ||
      (!sid && createdSession.current === pendingMessage.sid)) &&
    !data?.messages.some(
      (m: any) =>
        m.client_id === pendingMessage.message.client_id &&
        m.author_id === pendingMessage.message.author_id,
    )
      ? [pendingMessage.message]
      : [];
  const messages = [...(data?.messages || []), ...pending].map((m: any) => ({
    key: m.client_id ? `${m.author_id}:${m.client_id}` : m.id,
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
          {m.libraryFiles?.map((file: any) => (
            <a
              className="chat-file"
              key={file.id}
              href={`/api/projects/${pid}/files/${file.id}/download`}
              target="_blank"
              rel="noreferrer"
            >
              <FolderOpen size={14} />
              测试文件 · {file.name}
              {file.archived_at ? "（已归档）" : ""}
            </a>
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
      ) : m.sending ? (
        <Tag color="processing" role="status">
          发送中
        </Tag>
      ) : undefined,
  }));
  return (
    <>
      <Heading
        title="Agent 对话"
        note="描述目标、上传测试文件或页面截图，让 Agent 调查、编排并验证测试。"
        actions={
          <Space wrap>
            <BrowserPreview key={sid} id={run?.id} status={run?.status} />
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
            {running && intervention.data?.active && run && (
              <Alert
                type="warning"
                showIcon
                title="等待人工处理"
                description={
                  intervention.data.info?.message ||
                  "请接管浏览器，处理完成后继续运行。"
                }
                action={
                  <Link to={`/projects/${pid}/runs?env=${eid}&run=${run.id}`}>
                    前往人工接管
                  </Link>
                }
              />
            )}
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
            {sid && conversation.isPending && !messages.length ? (
              <Spin />
            ) : messages.length ? (
              <>
                {data?.hasOlder && (
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
                  也可以先讨论需求，或拖入测试文件 / 截图。告诉
                  Agent「这个要记住」即可保存测试经验。
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
              {libraryFiles.length > 0 && (
                <div className="chat-pending-files" aria-label="已选测试文件">
                  {libraryFiles.map((file) => (
                    <Tag
                      key={file.id}
                      closable={!busy && !uploading}
                      onClose={(event) => {
                        event.preventDefault();
                        changeLibraryFiles(
                          libraryFiles.filter((item) => item.id !== file.id),
                        );
                      }}
                    >
                      测试文件 · {file.name}
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
                disabled={readOnly || busy}
                autoSize={{ minRows: 2, maxRows: 6 }}
                onSubmit={() => void send()}
                onPasteFile={(list) => void upload(Array.from(list))}
                prefix={
                  <Space size={0}>
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
                    <Tooltip title="从测试文件库选择">
                      <Button
                        aria-label="选择测试文件库文件"
                        type="text"
                        icon={<FolderOpen size={18} />}
                        disabled={readOnly || busy || uploading || running}
                        onClick={() => {
                          setFileSelection({});
                          setFilePage(1);
                          setFileSearch("");
                          setFilePicker(true);
                        }}
                      />
                    </Tooltip>
                  </Space>
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
                          (!draft.trim() &&
                            !files.length &&
                            !libraryFiles.length)
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
                <span>{model ? `${model} · ` : ""}Responses API</span>
                <span>
                  Enter 发送 · Shift+Enter 换行 · 临时附件 ≤ 5 MiB · 每条合计 ≤
                  12 MiB
                </span>
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
        title="选择测试文件库文件"
        open={filePicker}
        onCancel={() => setFilePicker(false)}
        onOk={() => {
          const selected = Object.values(fileSelection);
          const nextFiles = [
            ...libraryFiles,
            ...selected.filter(
              (file) => !libraryFiles.some((item) => item.id === file.id),
            ),
          ];
          const problem = fileSelectionError([...files, ...nextFiles]);
          if (problem) {
            message.error(problem);
            return;
          }
          changeLibraryFiles(nextFiles);
          setFilePicker(false);
        }}
        okText="添加到对话"
        cancelText="取消"
        okButtonProps={{ disabled: !Object.keys(fileSelection).length }}
        width={720}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          文本、图片和 PDF 可供 Agent 理解；其他文件可作为页面上传的测试输入。
          附件和测试文件每条合计最多 5 个、12 MiB。
        </Typography.Paragraph>
        <Input.Search
          aria-label="搜索文件库"
          placeholder="搜索文件名"
          allowClear
          onSearch={(value) => {
            setFilePage(1);
            setFileSearch(value);
          }}
          style={{ marginBottom: 12 }}
        />
        <Failure
          error={fileOptions.error}
          retry={() => void fileOptions.refetch()}
        />
        <Table
          size="small"
          rowKey="id"
          loading={fileOptions.isFetching}
          dataSource={fileOptions.data?.items || []}
          scroll={{ x: 500 }}
          rowSelection={{
            selectedRowKeys: Object.keys(fileSelection),
            preserveSelectedRowKeys: true,
            onSelect: (record: any, selected: boolean) => {
              setFileSelection((old) => {
                const next = { ...old };
                if (selected) next[record.id] = record;
                else delete next[record.id];
                return next;
              });
            },
            onSelectAll: (selected: boolean, _rows: any[], changed: any[]) => {
              setFileSelection((old) => {
                const next = { ...old };
                for (const file of changed) {
                  if (selected) next[file.id] = file;
                  else delete next[file.id];
                }
                return next;
              });
            },
          }}
          pagination={{
            current: filePage,
            pageSize: 20,
            total: fileOptions.data?.total || 0,
            showSizeChanger: false,
            onChange: (value) => setFilePage(value),
          }}
          columns={[
            { title: "文件名称", dataIndex: "name" },
            {
              title: "大小",
              dataIndex: "size",
              render: (size: number) =>
                size === 0
                  ? "0 B"
                  : `${Math.max(1, Math.ceil(size / 1024))} KB`,
            },
          ]}
        />
      </Modal>
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
