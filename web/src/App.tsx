import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  Workflow,
  FolderKanban,
  BookOpen,
  Blocks,
  FlaskConical,
  Play,
  History,
  Users,
  Plus,
  ChevronRight,
  LogOut,
  Check,
  X,
  Settings2,
  Copy,
  Download,
  RefreshCw,
  ArrowLeft,
  Sparkles,
  Layers,
  LoaderCircle,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "请求失败");
  return result;
}
const labels: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
};
function Badge({ status }: { status: string }) {
  return (
    <span className={"badge " + status}>
      {status === "running" && <LoaderCircle size={12} className="spin" />}
      {labels[status] || status}
    </span>
  );
}
function Empty({
  icon,
  children,
  action,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label>
      {label}
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function date(v: string) {
  return new Date(v).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const tabs = [
  { id: "cases", name: "测试用例", icon: FlaskConical },
  { id: "nodes", name: "共享节点", icon: Blocks },
  { id: "flows", name: "测试流程", icon: Workflow },
  { id: "knowledge", name: "知识库", icon: BookOpen },
  { id: "runs", name: "运行记录", icon: History },
  { id: "team", name: "项目成员", icon: Users },
];
const defaultSpec = {
  inputs: ["message"],
  steps: [
    { action: "fill", selector: "#message-input", value: "{{param.message}}" },
    { action: "click", selector: "#send-message" },
  ],
};
export function App() {
  const [user, setUser] = useState<any>(null),
    [boot, setBoot] = useState(true),
    [projects, setProjects] = useState<any[]>([]),
    [pid, setPid] = useState(""),
    [data, setData] = useState<any>(null),
    [eid, setEid] = useState("");
  const [tab, setTab] = useState("cases"),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [runId, setRunId] = useState(""),
    [runData, setRunData] = useState<any>(null),
    [filter, setFilter] = useState("");
  const [knowledgeText, setKnowledgeText] = useState(""),
    [flowSteps, setFlowSteps] = useState<any[]>([]),
    [versions, setVersions] = useState<any[]>([]);
  useEffect(() => {
    api("/auth/me")
      .then((r) => setUser(r.user))
      .catch((e) => setError(e.message))
      .finally(() => setBoot(false));
  }, []);
  const loadProjects = useCallback(async () => {
    const p = await api("/projects");
    setProjects(p);
    setPid((old) => (p.some((x: any) => x.id === old) ? old : p[0]?.id || ""));
  }, []);
  useEffect(() => {
    if (user) void loadProjects().catch((e) => setError(e.message));
  }, [user, loadProjects]);
  const refresh = useCallback(async () => {
    if (!pid) return;
    const d = await api(
      `/projects/${pid}${eid ? "?environmentId=" + eid : ""}`,
    );
    setData(d);
    if (!eid && d.environmentId) setEid(d.environmentId);
  }, [pid, eid]);
  useEffect(() => {
    let active = true;
    if (!pid) {
      setData(null);
      return;
    }
    const load = async () => {
      try {
        const d = await api(
          `/projects/${pid}${eid ? "?environmentId=" + eid : ""}`,
        );
        if (active) {
          setData(d);
          if (!eid && d.environmentId) setEid(d.environmentId);
        }
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [pid, eid]);
  useEffect(() => {
    if (!runId) {
      setRunData(null);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const d = await api("/runs/" + runId);
        if (active) setRunData(d);
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    void load();
    const t = setInterval(load, 1600);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [runId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const open = (kind: string, item?: any) => {
    setError("");
    setModal({ kind, item });
    setKnowledgeText(item?.content || "");
    if (kind === "flow") setFlowSteps(item?.steps || []);
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = data && data.role !== "viewer";
  const env = data?.environments.find((e: any) => e.id === eid);
  const visibleNodes = (data?.nodes || []).filter((n: any) =>
    (n.name + n.key + n.description)
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  async function start(
    mode: string,
    caseId: string,
    flowId?: string,
    repairNodeId?: string,
  ) {
    if (!eid) throw new Error("请先创建并选择环境");
    const r = await api(`/projects/${pid}/runs`, "POST", {
      environmentId: eid,
      caseId,
      mode,
      flowId,
      repairNodeId,
    });
    setRunId(r.id);
    setModal(null);
    await refresh();
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (key: string) => String(f.get(key) || "");
    await perform(async () => {
      const item = modal.item;
      switch (modal.kind) {
        case "project": {
          const p = await api("/projects", "POST", {
            name: get("name"),
            description: get("description"),
          });
          await loadProjects();
          setEid("");
          setPid(p.id);
          setData(null);
          break;
        }
        case "env":
          await api(
            `/projects/${pid}/environments${item ? "/" + item.id : ""}`,
            item ? "PUT" : "POST",
            {
              name: get("name"),
              baseUrl: get("baseUrl"),
              variables: JSON.parse(get("variables") || "{}"),
              ...(get("secrets").trim()
                ? { secrets: JSON.parse(get("secrets")) }
                : {}),
            },
          );
          await refresh();
          break;
        case "clone": {
          const result = await api(
            `/projects/${pid}/environments/${eid}/clone`,
            "POST",
            {
              name: get("name"),
              baseUrl: get("baseUrl"),
              copySecrets: f.get("copySecrets") === "on",
            },
          );
          setEid(result.id);
          setToast(
            `已复制 ${result.copiedRevisions} 个节点版本和 ${result.copiedFlows} 个流程`,
          );
          break;
        }
        case "knowledge":
          await api(
            `/projects/${pid}/knowledge${item ? "/" + item.id : ""}`,
            item ? "PUT" : "POST",
            { title: get("title"), content: knowledgeText },
          );
          await refresh();
          break;
        case "case":
          await api(
            `/projects/${pid}/cases${item ? "/" + item.id : ""}`,
            item ? "PUT" : "POST",
            { title: get("title"), instructions: get("instructions") },
          );
          await refresh();
          break;
        case "node":
          await api(`/projects/${pid}/nodes`, "POST", {
            environmentId: eid,
            key: get("key"),
            name: get("name"),
            description: get("description"),
            spec: JSON.parse(get("spec")),
          });
          await refresh();
          setToast("已保存节点版本，已有流程仍引用原版本");
          break;
        case "flow":
          await api(`/projects/${pid}/flows`, "POST", {
            environmentId: eid,
            caseId: get("caseId"),
            name: get("name"),
            steps: flowSteps,
          });
          await refresh();
          break;
        case "member":
          await api(`/projects/${pid}/members`, "POST", {
            email: get("email"),
            role: get("role"),
          });
          await refresh();
          break;
        case "repair":
          await start("repair", get("caseId"), undefined, item.node_id);
          break;
      }
      setModal(null);
    });
  }
  if (boot)
    return (
      <div className="loading-page">
        <LoaderCircle className="spin" /> 正在连接工作台
      </div>
    );
  if (!user) return <Auth onAuth={setUser} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-icon">
            <Workflow size={23} />
          </span>
          <span>
            LoopLab<small>AGENT TEST WORKSPACE</small>
          </span>
        </a>
        <div className="workspace-label">
          工作空间 <span>LOCAL</span>
        </div>
        <button
          className="workspace active"
          onClick={() => {
            setRunId("");
            setTab("cases");
          }}
        >
          <FolderKanban size={18} />
          项目工作台<span className="count">{projects.length}</span>
        </button>
        <div className="sidebar-heading">
          我的项目
          <button aria-label="新建项目" onClick={() => open("project")}>
            <Plus size={15} />
          </button>
        </div>
        <div className="project-list">
          {projects.map((p) => (
            <button
              key={p.id}
              className={p.id === pid ? "selected" : ""}
              onClick={() => {
                setPid(p.id);
                setEid("");
                setData(null);
                setRunId("");
                setFilter("");
              }}
            >
              <span className="project-dot" />
              {p.name}
              <ChevronRight size={13} />
            </button>
          ))}
          {!projects.length && (
            <small className="sidebar-hint">创建第一个项目开始测试</small>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="model-status">
            <span className="live-dot" />
            <div>
              GPT 6 Luna<small>Responses API · 专属运行时</small>
            </div>
          </div>
          <div className="user-row">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div>
              {user.name}
              <small>{user.email}</small>
            </div>
            <button
              aria-label="退出登录"
              onClick={() =>
                void perform(async () => {
                  await api("/auth/logout", "POST", {});
                  setUser(null);
                  setPid("");
                  setEid("");
                  setData(null);
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={14} />{" "}
            <b>{data?.project.name || "项目"}</b>
            {runId && (
              <>
                <ChevronRight size={14} />
                <span>运行详情</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className="live-dot" />
            <span>共享工作空间</span>
            <span className="divider" />
            <Users size={15} />
            <span>{data?.members.length || 1} 位成员</span>
          </div>
        </header>
        {error && !modal && (
          <div role="alert" className="alert">
            {error}
            <button onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {!pid ? (
          <div className="welcome">
            <span className="eyebrow">TEST ONCE. REUSE EVERYWHERE.</span>
            <h1>让每次测试，成为下一次的起点。</h1>
            <p>从项目知识出发，让 Agent 探索真实页面，沉淀可复用的测试节点。</p>
            <button className="primary" onClick={() => open("project")}>
              <Plus size={17} />
              创建第一个项目
            </button>
            <div className="welcome-cards">
              <div>
                <BookOpen />
                <h3>项目知识</h3>
                <p>让 Agent 了解你的产品与验证标准</p>
              </div>
              <div>
                <Blocks />
                <h3>共享节点</h3>
                <p>团队共建，一处修复，多次复用</p>
              </div>
              <div>
                <Play />
                <h3>真实验证</h3>
                <p>在浏览器中执行，保留每一步证据</p>
              </div>
            </div>
          </div>
        ) : !data ? (
          <div className="loading-page">
            <LoaderCircle className="spin" /> 正在加载项目
          </div>
        ) : runId ? (
          <RunView
            data={runData}
            onBack={() => {
              setRunId("");
              void refresh();
            }}
            canEdit={edit}
            onCancel={() =>
              void perform(async () => {
                await api(`/runs/${runId}/cancel`, "POST", {});
                setToast("已请求取消");
              })
            }
          />
        ) : (
          <div className="content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">PROJECT WORKSPACE</div>
                <h1>{data.project.name}</h1>
                <p>
                  {data.project.description ||
                    "从自然语言用例，到可重复执行的浏览器测试。"}
                </p>
              </div>
              <div className="heading-actions">
                <button
                  className="ghost"
                  onClick={() => open("env")}
                  disabled={!edit}
                >
                  <Plus size={16} />
                  添加环境
                </button>
                <button
                  className="primary"
                  onClick={() => open("case")}
                  disabled={!edit}
                >
                  <Plus size={16} />
                  新建用例
                </button>
              </div>
            </div>
            <div className="environment-bar">
              <span className="env-label">
                <Layers size={16} />
                当前环境
              </span>
              <select
                aria-label="当前环境"
                value={eid}
                onChange={(e) => {
                  setEid(e.target.value);
                  setFilter("");
                }}
              >
                <option value="" disabled>
                  选择部署环境
                </option>
                {data.environments.map((e: any) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <span className="env-url">
                {env?.base_url || "先添加被测项目的地址"}
              </span>
              {env && (
                <>
                  <button
                    className="icon-button"
                    title="环境配置"
                    aria-label="环境配置"
                    disabled={!edit}
                    onClick={() => open("env", env)}
                  >
                    <Settings2 size={16} />
                  </button>
                  <button
                    className="ghost small"
                    disabled={!edit}
                    onClick={() => open("clone")}
                  >
                    <Copy size={14} />
                    复制环境
                  </button>
                </>
              )}
            </div>
            <div className="metrics">
              <Metric
                title="测试用例"
                value={data.cases.length}
                note="覆盖产品核心场景"
                icon={<FlaskConical />}
              />
              <Metric
                title="可复用节点"
                value={data.nodes.length}
                note="当前环境 · 团队共享"
                icon={<Blocks />}
              />
              <Metric
                title="测试流程"
                value={data.flows.length}
                note="版本固定，可重复执行"
                icon={<Workflow />}
              />
              <Metric
                title="最近通过率"
                value={(() => {
                  const done = data.runs.filter(
                    (r: any) =>
                      r.environment_id === eid &&
                      ["passed", "failed"].includes(r.status),
                  );
                  return done.length
                    ? Math.round(
                        (done.filter((r: any) => r.status === "passed").length /
                          done.length) *
                          100,
                      ) + "%"
                    : "—";
                })()}
                note="当前环境 · 最近运行"
                icon={<Check />}
              />
            </div>
            <nav className="tabs">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? "active" : ""}
                  onClick={() => {
                    setTab(t.id);
                    setFilter("");
                  }}
                >
                  <t.icon size={16} />
                  {t.name}
                  {t.id === "nodes" && <span>{data.nodes.length}</span>}
                </button>
              ))}
            </nav>
            <section className="panel">
              {tab === "cases" && (
                <>
                  <SectionHead
                    title="测试用例"
                    description="描述目标与预期结果，Agent 将优先复用现有节点。"
                    action={
                      <button
                        className="ghost small"
                        disabled={!edit}
                        onClick={() => open("case")}
                      >
                        <Plus size={15} />
                        添加用例
                      </button>
                    }
                  />
                  {data.cases.length ? (
                    <div className="case-list">
                      {data.cases.map((c: any) => {
                        const flow = data.flows.find(
                          (f: any) => f.case_id === c.id,
                        );
                        return (
                          <article className="case-card" key={c.id}>
                            <div className="case-icon">
                              <FlaskConical size={20} />
                            </div>
                            <div className="case-main">
                              <h3>{c.title}</h3>
                              <p>{c.instructions}</p>
                              <div className="case-meta">
                                <span>
                                  {flow ? (
                                    <>
                                      <Check size={12} />
                                      已有可执行流程
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles size={12} />
                                      等待 Agent 编排
                                    </>
                                  )}
                                </span>
                                <span>{date(c.created_at)}</span>
                              </div>
                            </div>
                            <div className="case-actions">
                              <button
                                className="icon-button"
                                aria-label={"编辑 " + c.title}
                                disabled={!edit}
                                onClick={() => open("case", c)}
                              >
                                <Pencil size={15} />
                              </button>
                              {flow && (
                                <button
                                  className="ghost small"
                                  disabled={!edit || busy}
                                  onClick={() =>
                                    void perform(() =>
                                      start("execute", c.id, flow.id),
                                    )
                                  }
                                >
                                  <Play size={14} />
                                  直接回放
                                </button>
                              )}
                              <button
                                className="primary small"
                                disabled={!edit || !eid || busy}
                                onClick={() =>
                                  void perform(() => start("generate", c.id))
                                }
                              >
                                <Sparkles size={14} />
                                {flow ? "重新编排" : "Agent 生成并验证"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      icon={<FlaskConical />}
                      action={
                        <button
                          className="primary"
                          disabled={!edit}
                          onClick={() => open("case")}
                        >
                          <Plus size={16} />
                          添加测试用例
                        </button>
                      }
                    >
                      还没有测试用例。试试“登录后发送消息，并检查回复”。
                    </Empty>
                  )}
                </>
              )}
              {tab === "nodes" && (
                <>
                  <SectionHead
                    title="共享节点库"
                    description="节点按项目共享，实现在环境中独立版本化。"
                    action={
                      <>
                        <input
                          className="search"
                          aria-label="搜索节点"
                          placeholder="搜索节点名称…"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        />
                        <button
                          className="ghost small"
                          disabled={!edit || !eid}
                          onClick={() => open("node")}
                        >
                          <Plus size={15} />
                          新建节点
                        </button>
                      </>
                    }
                  />
                  {visibleNodes.length ? (
                    <div className="node-grid">
                      {visibleNodes.map((n: any) => (
                        <article className="node-card" key={n.node_id}>
                          <div className="node-card-top">
                            <span className="node-icon">
                              <Blocks size={19} />
                            </span>
                            <span className="version">v{n.version}</span>
                          </div>
                          <h3>{n.name}</h3>
                          <code className="node-key">{n.key}</code>
                          <p>{n.description || "可复用浏览器操作节点"}</p>
                          <div className="node-tags">
                            <span>{n.spec.steps.length} 个步骤</span>
                            <span>{n.spec.inputs.length} 个输入</span>
                          </div>
                          <div className="node-footer">
                            <button
                              disabled={!edit}
                              onClick={() => open("node", n)}
                            >
                              <Pencil size={13} />
                              编辑版本
                            </button>
                            <button
                              disabled={!edit || !data.cases.length}
                              onClick={() => open("repair", n)}
                            >
                              <RefreshCw size={13} />
                              Agent 修复
                            </button>
                            <button
                              title="查看版本"
                              onClick={() =>
                                void perform(async () => {
                                  setVersions(
                                    await api(
                                      `/projects/${pid}/nodes/${n.node_id}/versions`,
                                    ),
                                  );
                                  open("versions", n);
                                })
                              }
                            >
                              <History size={14} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<Blocks />}>
                      执行一次 Agent
                      生成，或手动创建节点。团队成员会共享这里的资产。
                    </Empty>
                  )}
                </>
              )}
              {tab === "flows" && (
                <>
                  <SectionHead
                    title="测试流程"
                    description="每个流程固定引用节点版本，后续更新不会改写历史。"
                    action={
                      <button
                        className="ghost small"
                        disabled={
                          !edit || !data.nodes.length || !data.cases.length
                        }
                        onClick={() => open("flow")}
                      >
                        <Plus size={15} />
                        组合流程
                      </button>
                    }
                  />
                  {data.flows.length ? (
                    <div className="flow-list">
                      {data.flows.map((f: any) => (
                        <article className="flow-card" key={f.id}>
                          <div className="flow-title">
                            <div>
                              <h3>{f.name}</h3>
                              <small>
                                {
                                  data.cases.find(
                                    (c: any) => c.id === f.case_id,
                                  )?.title
                                }{" "}
                                · {date(f.created_at)}
                              </small>
                            </div>
                            <div className="row">
                              <a
                                className="ghost small button-link"
                                href={`/api/projects/${pid}/flows/${f.id}/export`}
                              >
                                <Download size={14} />
                                TS 脚本
                              </a>
                              <button
                                className="ghost small"
                                disabled={!edit}
                                onClick={() => open("flow", f)}
                              >
                                <Copy size={14} />
                                编辑副本
                              </button>
                              <button
                                className="primary small"
                                disabled={!edit || busy}
                                onClick={() =>
                                  void perform(() =>
                                    start("execute", f.case_id, f.id),
                                  )
                                }
                              >
                                <Play size={14} />
                                执行
                              </button>
                            </div>
                          </div>
                          <div className="flow-nodes">
                            {f.steps.map((s: any, i: number) => {
                              const n = data.nodes.find(
                                (n: any) => n.revision_id === s.revisionId,
                              );
                              return (
                                <div className="flow-part" key={i}>
                                  <span className="flow-node">
                                    <span>{i + 1}</span>
                                    {n?.name || "已固定的历史节点"}
                                    <code>
                                      {n
                                        ? "v" + n.version
                                        : s.revisionId.slice(0, 6)}
                                    </code>
                                  </span>
                                  {i < f.steps.length - 1 && (
                                    <ChevronRight size={16} />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<Workflow />}>
                      Agent 生成的流程会出现在这里，也可以手动组合已有节点。
                    </Empty>
                  )}
                </>
              )}
              {tab === "knowledge" && (
                <>
                  <SectionHead
                    title="项目知识库"
                    description="产品说明、操作路径和预期行为，会在 Agent 开始任务时提供给它。"
                    action={
                      <button
                        className="ghost small"
                        disabled={!edit}
                        onClick={() => open("knowledge")}
                      >
                        <Plus size={15} />
                        添加知识
                      </button>
                    }
                  />
                  {data.knowledge.length ? (
                    <div className="knowledge-grid">
                      {data.knowledge.map((k: any) => (
                        <article className="knowledge-card" key={k.id}>
                          <BookOpen size={20} />
                          <h3>{k.title}</h3>
                          <p>{k.content}</p>
                          <footer>
                            <small>{date(k.updated_at)}</small>
                            <button
                              className="ghost small"
                              disabled={!edit}
                              onClick={() => open("knowledge", k)}
                            >
                              编辑
                            </button>
                            <button
                              className="icon-button"
                              aria-label={"删除 " + k.title}
                              disabled={!edit}
                              onClick={() =>
                                void perform(async () => {
                                  await api(
                                    `/projects/${pid}/knowledge/${k.id}`,
                                    "DELETE",
                                  );
                                  await refresh();
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </footer>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<BookOpen />}>
                      添加一份产品说明，帮助 Agent 理解页面与测试标准。
                    </Empty>
                  )}
                </>
              )}
              {tab === "runs" && (
                <>
                  <SectionHead
                    title="运行记录"
                    description="生成、回放和修复均保留步骤日志、截图与版本快照。"
                  />
                  {data.runs.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>测试用例</th>
                            <th>环境</th>
                            <th>任务</th>
                            <th>结果</th>
                            <th>开始时间</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {data.runs.map((r: any) => (
                            <tr key={r.id} onClick={() => setRunId(r.id)}>
                              <td>
                                <b>
                                  {
                                    data.cases.find(
                                      (c: any) => c.id === r.case_id,
                                    )?.title
                                  }
                                </b>
                                <small>{r.id.slice(0, 8)}</small>
                              </td>
                              <td>
                                {
                                  data.environments.find(
                                    (e: any) => e.id === r.environment_id,
                                  )?.name
                                }
                              </td>
                              <td>
                                {
                                  {
                                    generate: "Agent 生成",
                                    execute: "流程回放",
                                    repair: "节点修复",
                                  }[r.mode as string]
                                }
                              </td>
                              <td>
                                <Badge status={r.status} />
                              </td>
                              <td>{date(r.created_at)}</td>
                              <td>
                                <ChevronRight size={16} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty icon={<History />}>
                      运行你的第一个用例，查看实际验证过程。
                    </Empty>
                  )}
                </>
              )}
              {tab === "team" && (
                <>
                  <SectionHead
                    title="项目成员"
                    description="所有成员共享知识库、节点和执行记录。编辑者可以维护和执行测试。"
                    action={
                      <button
                        className="ghost small"
                        disabled={data.role !== "owner"}
                        onClick={() => open("member")}
                      >
                        <Plus size={15} />
                        添加成员
                      </button>
                    }
                  />
                  <div className="member-list">
                    {data.members.map((m: any) => (
                      <div className="member" key={m.id}>
                        <div className="avatar">{m.name.slice(0, 1)}</div>
                        <div>
                          <b>{m.name}</b>
                          <small>{m.email}</small>
                        </div>
                        <span className="role">
                          {
                            {
                              owner: "所有者",
                              editor: "编辑者",
                              viewer: "只读成员",
                            }[m.role as string]
                          }
                        </span>
                        {data.role === "owner" && m.role !== "owner" && (
                          <button
                            className="icon-button"
                            aria-label={"移除 " + m.name}
                            onClick={() =>
                              void perform(async () => {
                                await api(
                                  `/projects/${pid}/members/${m.id}`,
                                  "DELETE",
                                );
                                await refresh();
                              })
                            }
                          >
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="info-note">
                    多人协作通过共同的服务和 PostgreSQL
                    数据库完成，组件不会按用户各生成一份。
                  </div>
                </>
              )}
            </section>
            <footer className="page-footer">
              <span>LOOPLAB · 为可重复的验证而构建</span>
              <span>项目隔离 / 环境版本 / 团队复用</span>
            </footer>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast">
          <Check size={17} />
          {toast}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            className={
              "modal " +
              (["node", "flow", "versions"].includes(modal.kind) ? "wide" : "")
            }
          >
            <header>
              <div>
                <span className="eyebrow">WORKSPACE ACTION</span>
                <h2 id="dialog-title">
                  {
                    (
                      {
                        project: "创建项目",
                        env: modal.item ? "环境配置" : "添加环境",
                        clone: "复制环境",
                        case: modal.item ? "编辑测试用例" : "新建测试用例",
                        knowledge: modal.item ? "编辑知识" : "添加项目知识",
                        node: modal.item ? "创建节点新版本" : "新建可复用节点",
                        flow: "组合测试流程",
                        member: "添加项目成员",
                        repair: "让 Agent 修复节点",
                        versions: "节点版本历史",
                      } as any
                    )[modal.kind]
                  }
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </header>
            {error && (
              <div role="alert" className="alert">
                {error}
              </div>
            )}
            {modal.kind === "versions" ? (
              <div className="versions">
                {versions.map((v) => (
                  <details key={v.id}>
                    <summary>
                      v{v.version} ·{" "}
                      {
                        data?.environments.find(
                          (e: any) => e.id === v.environment_id,
                        )?.name
                      }{" "}
                      · {date(v.created_at)}
                    </summary>
                    <pre>{v.source}</pre>
                  </details>
                ))}
              </div>
            ) : (
              <form onSubmit={submit}>
                <div className="form-body">
                  {modal.kind === "project" && (
                    <>
                      <Field label="项目名称">
                        <input
                          name="name"
                          required
                          placeholder="例如：Agent 对话平台"
                          autoFocus
                        />
                      </Field>
                      <Field label="项目说明">
                        <textarea
                          name="description"
                          placeholder="这个产品解决什么问题？"
                        />
                      </Field>
                    </>
                  )}
                  {modal.kind === "env" && (
                    <>
                      <Field label="环境名称">
                        <input
                          name="name"
                          defaultValue={modal.item?.name}
                          placeholder="开发环境"
                          required
                          autoFocus
                        />
                      </Field>
                      <Field label="被测应用地址">
                        <input
                          name="baseUrl"
                          type="url"
                          defaultValue={modal.item?.base_url}
                          placeholder="https://app.example.com"
                          required
                        />
                      </Field>
                      <Field
                        label="环境变量（JSON）"
                        hint="使用 {{var.key}} 在节点中引用"
                      >
                        <textarea
                          className="code-input"
                          name="variables"
                          defaultValue={JSON.stringify(
                            modal.item?.variables || {},
                            null,
                            2,
                          )}
                        />
                      </Field>
                      <Field
                        label="登录凭据（JSON）"
                        hint={
                          modal.item
                            ? `已有字段：${modal.item.secretKeys.join(", ") || "无"}。留空保留；填写 JSON 会替换整份凭据。`
                            : "加密保存，使用 {{secret.username}}、{{secret.password}} 引用"
                        }
                      >
                        <textarea
                          className="code-input"
                          name="secrets"
                          autoComplete="off"
                          placeholder={'{"username":"…","password":"…"}'}
                        />
                      </Field>
                    </>
                  )}
                  {modal.kind === "clone" && (
                    <>
                      <p className="muted">
                        复制「{env?.name}」的全部节点版本和流程，之后独立维护。
                      </p>
                      <Field label="新环境名称">
                        <input name="name" required placeholder="预发布环境" />
                      </Field>
                      <Field label="新环境地址">
                        <input
                          name="baseUrl"
                          type="url"
                          required
                          defaultValue={env?.base_url}
                        />
                      </Field>
                      <label className="checkbox">
                        <input type="checkbox" name="copySecrets" />
                        同时复制加密凭据
                      </label>
                    </>
                  )}
                  {modal.kind === "case" && (
                    <>
                      <Field label="用例名称">
                        <input
                          name="title"
                          required
                          defaultValue={modal.item?.title}
                          placeholder="对话平台最小可用性"
                          autoFocus
                        />
                      </Field>
                      <Field
                        label="测试目标与预期结果"
                        hint="说明前置条件、操作步骤以及什么结果代表成功。"
                      >
                        <textarea
                          name="instructions"
                          rows={7}
                          required
                          defaultValue={modal.item?.instructions}
                          placeholder="登录平台，发送一条消息，确认回复区域出现非空内容，并保存截图。"
                        />
                      </Field>
                    </>
                  )}
                  {modal.kind === "knowledge" && (
                    <>
                      <Field label="标题">
                        <input
                          name="title"
                          required
                          defaultValue={modal.item?.title}
                          placeholder="产品操作说明"
                        />
                      </Field>
                      <Field label="内容">
                        <textarea
                          rows={10}
                          required
                          value={knowledgeText}
                          onChange={(e) => setKnowledgeText(e.target.value)}
                          placeholder="介绍登录方式、核心页面、操作流程、测试数据和预期行为…"
                        />
                      </Field>
                      <Field label="或导入文本文件">
                        <input
                          type="file"
                          accept=".md,.txt"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (f) {
                              if (f.size > 200000) {
                                setError("文件过大");
                                return;
                              }
                              setKnowledgeText(await f.text());
                            }
                          }}
                        />
                      </Field>
                    </>
                  )}
                  {modal.kind === "node" && (
                    <>
                      <div className="form-row">
                        <Field label="节点名称">
                          <input
                            name="name"
                            required
                            defaultValue={modal.item?.name}
                            placeholder="发送消息"
                          />
                        </Field>
                        <Field label="唯一标识">
                          <input
                            name="key"
                            required
                            readOnly={!!modal.item}
                            pattern="[a-z][a-z0-9_-]{1,63}"
                            defaultValue={modal.item?.key}
                            placeholder="send_message"
                          />
                        </Field>
                      </div>
                      <Field label="用途说明">
                        <input
                          name="description"
                          defaultValue={modal.item?.description}
                        />
                      </Field>
                      <Field
                        label="节点步骤（JSON）"
                        hint="支持 navigate / fill / click / press / assertText / assertVisible / waitFor / screenshot / extractText。变量示例：{{param.message}}。"
                      >
                        <textarea
                          className="code-input"
                          name="spec"
                          rows={14}
                          required
                          defaultValue={JSON.stringify(
                            modal.item?.spec || defaultSpec,
                            null,
                            2,
                          )}
                        />
                      </Field>
                    </>
                  )}
                  {modal.kind === "flow" && (
                    <>
                      <div className="form-row">
                        <Field label="流程名称">
                          <input
                            name="name"
                            required
                            defaultValue={
                              modal.item ? modal.item.name + " · 新版本" : ""
                            }
                          />
                        </Field>
                        <Field label="对应测试用例">
                          <select
                            name="caseId"
                            defaultValue={modal.item?.case_id}
                            required
                          >
                            {data.cases.map((c: any) => (
                              <option key={c.id} value={c.id}>
                                {c.title}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <NodeComposer
                        nodes={data.nodes}
                        steps={flowSteps}
                        onChange={setFlowSteps}
                      />
                    </>
                  )}
                  {modal.kind === "member" && (
                    <>
                      <Field label="成员邮箱" hint="该用户需先在工作台注册。">
                        <input
                          name="email"
                          type="email"
                          required
                          placeholder="colleague@example.com"
                        />
                      </Field>
                      <Field label="权限">
                        <select name="role">
                          <option value="editor">
                            编辑者 · 创建、修改与执行
                          </option>
                          <option value="viewer">
                            只读成员 · 查看资产与报告
                          </option>
                        </select>
                      </Field>
                    </>
                  )}
                  {modal.kind === "repair" && (
                    <>
                      <div className="info-note">
                        修复「{modal.item.name}
                        」在当前环境的实现，创建新版本并重新编排验证。原有断言的预期结果保持不变。
                      </div>
                      <Field label="用于验证修复的测试用例">
                        <select name="caseId">
                          {data.cases.map((c: any) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </>
                  )}
                </div>
                <footer className="modal-footer">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => setModal(null)}
                  >
                    取消
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy || (modal.kind === "flow" && !flowSteps.length)
                    }
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : modal.kind === "repair" ? (
                      <Sparkles size={15} />
                    ) : (
                      <Check size={15} />
                    )}{" "}
                    {modal.kind === "repair" ? "开始修复" : "保存"}
                  </button>
                </footer>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Metric({
  title,
  value,
  note,
  icon,
}: {
  title: string;
  value: ReactNode;
  note: string;
  icon: ReactNode;
}) {
  return (
    <div className="metric">
      <div>
        <span>{title}</span>
        <div className="metric-value">{value}</div>
        <small>{note}</small>
      </div>
      <div className="metric-icon">{icon}</div>
    </div>
  );
}
function SectionHead({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-head">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="row">{action}</div>
    </header>
  );
}
function NodeComposer({
  nodes,
  steps,
  onChange,
}: {
  nodes: any[];
  steps: any[];
  onChange: (s: any[]) => void;
}) {
  const [selected, setSelected] = useState(nodes[0]?.revision_id || "");
  return (
    <div className="composer">
      <div className="row">
        <select
          aria-label="选择复用节点"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {nodes.map((n) => (
            <option key={n.revision_id} value={n.revision_id}>
              {n.name} · v{n.version}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost"
          onClick={() =>
            onChange([...steps, { revisionId: selected, params: {} }])
          }
          disabled={!selected}
        >
          <Plus size={15} />
          添加节点
        </button>
      </div>
      {steps.map((s, i) => {
        const n = nodes.find((n) => n.revision_id === s.revisionId);
        return (
          <div className="composer-step" key={i}>
            <div className="row">
              <span className="step-number">{i + 1}</span>
              <b>{n?.name || "历史版本 " + s.revisionId.slice(0, 8)}</b>
              <span className="grow" />
              <button
                type="button"
                className="icon-button"
                aria-label="上移节点"
                disabled={i === 0}
                onClick={() => {
                  const next = [...steps];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="下移节点"
                disabled={i === steps.length - 1}
                onClick={() => {
                  const next = [...steps];
                  [next[i + 1], next[i]] = [next[i], next[i + 1]];
                  onChange(next);
                }}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="移除节点"
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
              >
                <X size={14} />
              </button>
            </div>
            {(n?.spec.inputs || Object.keys(s.params)).map((key: string) => (
              <Field key={key} label={key}>
                <input
                  required
                  value={s.params[key] || ""}
                  onChange={(e) =>
                    onChange(
                      steps.map((old, j) =>
                        j === i
                          ? {
                              ...old,
                              params: { ...old.params, [key]: e.target.value },
                            }
                          : old,
                      ),
                    )
                  }
                />
              </Field>
            ))}
          </div>
        );
      })}
      {!steps.length && (
        <p className="muted">按执行顺序添加节点，再填写每个节点的输入参数。</p>
      )}
    </div>
  );
}
function RunView({
  data,
  onBack,
  canEdit,
  onCancel,
}: {
  data: any;
  onBack: () => void;
  canEdit: boolean;
  onCancel: () => void;
}) {
  const [showAgent, setShowAgent] = useState(true);
  if (!data)
    return (
      <div className="loading-page">
        <LoaderCircle className="spin" />
        正在加载执行记录
      </div>
    );
  const { run, events, artifacts } = data;
  const active = ["queued", "running"].includes(run.status);
  const filtered = events.filter(
    (e: any) => showAgent || !e.kind.startsWith("agent_"),
  );
  return (
    <div className="content">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        返回项目
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">RUN / {run.id.slice(0, 8)}</div>
          <h1>
            {run.snapshot?.testCase.title || "测试执行"}{" "}
            <Badge status={run.status} />
          </h1>
          <p>{run.summary || "任务已进入共享队列，执行过程会自动更新。"}</p>
        </div>
        <div className="row">
          {active && canEdit && (
            <button className="ghost" onClick={onCancel}>
              <X size={15} />
              取消运行
            </button>
          )}
          <button
            className="ghost"
            onClick={() => {
              const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `run-${run.id}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={15} />
            导出报告
          </button>
        </div>
      </div>
      <div className="run-summary">
        <div>
          <small>任务类型</small>
          <b>
            {
              {
                generate: "Agent 生成 + 验证",
                execute: "固定流程回放",
                repair: "节点修复 + 验证",
              }[run.mode as string]
            }
          </b>
        </div>
        <div>
          <small>提交时间</small>
          <b>{date(run.created_at)}</b>
        </div>
        <div>
          <small>执行步骤</small>
          <b>
            {
              events.filter(
                (e: any) => e.kind === "step" && e.data.status === "passed",
              ).length
            }{" "}
            已通过
          </b>
        </div>
        <div>
          <small>截图证据</small>
          <b>{artifacts.length} 张</b>
        </div>
      </div>
      {run.error && (
        <div className="run-error">
          <b>失败原因</b>
          <pre>{run.error}</pre>
        </div>
      )}
      <div className="run-columns">
        <section className="panel">
          <SectionHead
            title="执行时间线"
            description="记录 Agent 决策、节点执行与实际断言。"
            action={
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showAgent}
                  onChange={(e) => setShowAgent(e.target.checked)}
                />
                Agent 日志
              </label>
            }
          />
          <div className="timeline">
            {filtered.map((e: any) => (
              <div
                className={
                  "timeline-item " +
                  (e.kind === "run_failed" || e.data.status === "failed"
                    ? "failure"
                    : "")
                }
                key={e.id}
              >
                <div className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-title">
                    <b>{eventTitle(e)}</b>
                    <time>{date(e.created_at)}</time>
                  </div>
                  {e.kind === "agent_message" ? (
                    <p className="agent-text">
                      {e.data.text || "Agent 正在调用工具…"}
                    </p>
                  ) : (
                    <details>
                      <summary>{eventDescription(e)}</summary>
                      <pre>{JSON.stringify(e.data, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {active && (
              <div className="timeline-pending">
                <LoaderCircle size={16} className="spin" />
                正在执行，刷新或离开页面不会中止任务
              </div>
            )}
          </div>
        </section>
        <aside className="panel evidence">
          <SectionHead
            title="执行证据"
            description="截图保存在共享数据库中。"
          />
          {artifacts.length ? (
            artifacts.map((a: any) => (
              <a
                key={a.id}
                href={"/api/artifacts/" + a.id}
                target="_blank"
                rel="noreferrer"
              >
                <img src={"/api/artifacts/" + a.id} alt={a.name} />
                <span>
                  {a.name}
                  <small>{date(a.created_at)}</small>
                </span>
              </a>
            ))
          ) : (
            <Empty icon={<Layers />}>执行后显示截图</Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
function eventTitle(e: any) {
  return (
    (
      {
        run_started: "任务开始",
        agent_message: "Agent",
        agent_tool_start: "调用工具 · " + e.data.name,
        agent_tool_end: "工具完成 · " + e.data.name,
        node_saved: "保存共享节点",
        flow_saved: "保存测试流程",
        node_start: "开始节点 · " + e.data.name,
        node_passed: "节点通过 · " + e.data.name,
        step:
          (
            { start: "执行步骤", passed: "步骤通过", failed: "步骤失败" } as any
          )[e.data.status] +
          " · " +
          e.data.step?.action,
        artifact: "保存截图",
        run_passed: "测试通过",
        run_failed: "任务结束",
      } as any
    )[e.kind] || e.kind
  );
}
function eventDescription(e: any) {
  if (e.kind === "step")
    return (
      e.data.error ||
      e.data.step?.selector ||
      e.data.step?.url ||
      e.data.step?.name ||
      "查看步骤详情"
    );
  if (e.kind === "node_saved")
    return (
      e.data.key + " · v" + e.data.version + (e.data.reused ? " · 已复用" : "")
    );
  if (e.kind === "artifact") return e.data.name;
  return e.data.error || "查看详细记录";
}
function Auth({ onAuth }: { onAuth: (u: any) => void }) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand">
          <span className="brand-icon">
            <Workflow size={25} />
          </span>
          <span>LoopLab</span>
        </div>
        <div>
          <div className="eyebrow">FROM INTENT TO EVIDENCE</div>
          <h1>
            描述目标。
            <br />
            让验证发生。
          </h1>
          <p>
            Agent 理解你的产品，探索真实页面。
            <br />
            每一次测试，都积累为团队可以复用的能力。
          </p>
          <div className="auth-flow">
            <span>
              <BookOpen size={17} />
              项目知识
            </span>
            <ChevronRight />
            <span>
              <Blocks size={17} />
              共享节点
            </span>
            <ChevronRight />
            <span>
              <Check size={17} />
              验证结果
            </span>
          </div>
        </div>
        <small>GPT 6 Luna · 浏览器端到端验证 · 团队共享</small>
      </section>
      <section className="auth-form">
        <div className="eyebrow">YOUR TEST WORKSPACE</div>
        <h2>{register ? "创建你的账户" : "欢迎回来"}</h2>
        <p>
          {register
            ? "加入工作台，与团队共享测试资产。"
            : "登录后，继续构建可靠的测试流程。"}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              const result = await api(
                "/auth/" + (register ? "register" : "login"),
                "POST",
                {
                  email: f.get("email"),
                  password: f.get("password"),
                  ...(register ? { name: f.get("name") } : {}),
                },
              );
              onAuth(result.user);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {register && (
            <Field label="姓名">
              <input name="name" autoComplete="name" required />
            </Field>
          )}
          <Field label="邮箱">
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@company.com"
            />
          </Field>
          <Field label="密码">
            <input
              name="password"
              type="password"
              minLength={register ? 10 : 1}
              autoComplete={register ? "new-password" : "current-password"}
              required
              placeholder={register ? "至少 10 个字符" : "输入密码"}
            />
          </Field>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : null}
            {register ? "创建账户" : "登录工作台"}
            <ChevronRight size={17} />
          </button>
        </form>
        <p className="auth-switch">
          {register ? "已有账户？" : "第一次使用？"}
          <button
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "去登录" : "创建账户"}
          </button>
        </p>
        <small className="auth-footnote">
          你的项目、知识与测试节点保存在共享 PostgreSQL 工作空间。
        </small>
      </section>
    </main>
  );
}
