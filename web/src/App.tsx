import { lazy, Suspense, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  App as AntApp,
  Alert,
  Avatar,
  Button,
  ConfigProvider,
  Form,
  Input,
  Layout,
  Menu,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  Blocks,
  BookOpen,
  FlaskConical,
  FolderKanban,
  History,
  Layers,
  LogOut,
  MessageSquare,
  Users,
  Workflow,
} from "lucide-react";
import { api, Failure, queryClient, useApi } from "./admin/client";
import "./admin/admin.css";
const Projects = lazy(() => import("./admin/Projects"));
const AgentChat = lazy(() => import("./admin/AgentChat"));
const Resources = lazy(() => import("./admin/Resources"));
const RunDetail = lazy(() => import("./admin/RunDetail"));
export const sections = [
  ["agent", "Agent 对话", MessageSquare],
  ["environments", "环境管理", Layers],
  ["cases", "测试用例", FlaskConical],
  ["nodes", "共享节点", Blocks],
  ["flows", "测试流程", Workflow],
  ["knowledge", "知识库", BookOpen],
  ["runs", "运行记录", History],
  ["team", "项目成员", Users],
] as const;
export function App() {
  return (
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#15765d",
          borderRadius: 8,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
        },
        components: {
          Layout: { siderBg: "#142333", headerBg: "#fff" },
          Menu: { darkItemBg: "#142333", darkItemSelectedBg: "#234939" },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Session />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
function Session() {
  const user = useApi(["session"], "/auth/me");
  if (user.isPending)
    return (
      <div className="boot">
        <Spin tip="正在连接工作台">
          <div style={{ padding: 40 }} />
        </Spin>
      </div>
    );
  if (user.error)
    return <Failure error={user.error} retry={() => void user.refetch()} />;
  if (!user.data?.user) return <Auth />;
  return (
    <Routes>
      <Route path="/projects" element={<Shell user={user.data.user} />} />
      <Route
        path="/projects/:pid/:section"
        element={<Shell user={user.data.user} />}
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
function Auth() {
  const [register, setRegister] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const cache = useQueryClient();
  return (
    <div className="auth-layout">
      <div className="auth-story">
        <Workflow size={42} />
        <Typography.Title>LoopLab</Typography.Title>
        <h2>把一次探索，变成团队可复用的测试。</h2>
        <p>项目知识库 · 环境隔离 · 共享节点 · 真实浏览器验证</p>
        <Tag color="green">GPT 6 Luna / Responses API</Tag>
      </div>
      <div className="auth-form">
        <Typography.Title level={2}>
          {register ? "创建账户" : "登录工作台"}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          与团队共享测试组件、环境与执行记录。
        </Typography.Paragraph>
        <Failure error={error} />
        <Form
          layout="vertical"
          onFinish={async (values) => {
            setPending(true);
            setError(null);
            try {
              const r = await api(
                "/auth/" + (register ? "register" : "login"),
                "POST",
                values,
              );
              cache.removeQueries({
                predicate: (q) => q.queryKey[0] !== "session",
              });
              cache.setQueryData(["session"], r);
            } catch (e) {
              setError(e as Error);
            } finally {
              setPending(false);
            }
          }}
        >
          {register && (
            <Form.Item label="姓名" name="name" rules={[{ required: true }]}>
              <Input autoComplete="name" />
            </Form.Item>
          )}
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true }, { type: "email" }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true }, { min: register ? 10 : 1 }]}
          >
            <Input.Password
              autoComplete={register ? "new-password" : "current-password"}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={pending}>
            {register ? "创建账户" : "登录"}
          </Button>
        </Form>
        <Button
          type="link"
          onClick={() => {
            setError(null);
            setRegister(!register);
          }}
        >
          {register ? "已有账户？登录" : "创建新账户"}
        </Button>
      </div>
    </div>
  );
}
function Shell({ user }: { user: any }) {
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia("(max-width: 991px)").matches,
  );
  const { pid, section } = useParams(),
    [search, setSearch] = useSearchParams(),
    navigate = useNavigate();
  const cache = useQueryClient();
  const { message } = AntApp.useApp();
  const workspace = useApi(
    ["workspace", pid],
    `/projects/${pid}/workspace`,
    !!pid,
  );
  const data = workspace.data;
  const selected =
    search.get("env") ||
    data?.environments.find((e: any) => !e.archived_at)?.id ||
    "";
  const env = data?.environments.find((e: any) => e.id === selected);
  const valid = sections.some((s) => s[0] === section);
  const runId = search.get("run");
  return (
    <Layout className="admin-shell">
      <Layout.Sider
        collapsed={collapsed}
        onCollapse={setCollapsed}
        onBreakpoint={setCollapsed}
        breakpoint="lg"
        collapsedWidth={0}
        width={228}
        className="admin-sidebar"
      >
        <Link className="admin-brand" to="/projects">
          <Workflow size={27} />
          <span>
            LoopLab<small>AGENT TEST WORKSPACE</small>
          </span>
        </Link>
        <Menu
          onClick={() => {
            if (window.innerWidth < 992) setCollapsed(true);
          }}
          theme="dark"
          selectedKeys={pid ? [section || "environments"] : ["projects"]}
          items={[
            {
              key: "projects",
              icon: <FolderKanban size={18} />,
              label: <Link to="/projects">项目管理</Link>,
            },
            ...(pid
              ? sections.map(([key, label, Icon]) => ({
                  key,
                  icon: <Icon size={18} />,
                  label: (
                    <Link
                      to={`/projects/${pid}/${key}${selected ? "?env=" + selected : ""}`}
                    >
                      {label}
                    </Link>
                  ),
                }))
              : []),
          ]}
        />
        <div className="sidebar-caption">
          <span className="online-dot" />
          GPT 6 Luna<p>共享 PostgreSQL · 浏览器执行</p>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="admin-header">
          <Space>
            <Link to="/projects">工作空间</Link>
            {pid && (
              <>
                <span>/</span>
                <Typography.Text strong>
                  {data?.project.name || "加载项目…"}
                </Typography.Text>
              </>
            )}
          </Space>
          <Space>
            <Avatar size="small">{user.name[0]}</Avatar>
            <span className="user-name">{user.name}</span>
            <Button
              aria-label="退出登录"
              type="text"
              icon={<LogOut size={16} />}
              onClick={async () => {
                try {
                  await api("/auth/logout", "POST");
                  cache.removeQueries({
                    predicate: (q) => q.queryKey[0] !== "session",
                  });
                  cache.setQueryData(["session"], { user: null });
                  navigate("/projects");
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            />
          </Space>
        </Layout.Header>
        <Layout.Content className="admin-content">
          <Suspense fallback={<Spin />}>
            {!pid ? (
              <Projects />
            ) : workspace.error ? (
              <Failure
                error={workspace.error}
                retry={() => void workspace.refetch()}
              />
            ) : !data ? (
              <Spin />
            ) : (
              <>
                <div className="context-bar">
                  <Space wrap>
                    <Tag>
                      {data.role === "owner"
                        ? "项目所有者"
                        : data.role === "viewer"
                          ? "只读成员"
                          : "编辑者"}
                    </Tag>
                    <Typography.Text type="secondary">当前环境</Typography.Text>
                    <Select
                      aria-label="当前环境"
                      style={{ minWidth: 180 }}
                      value={selected || undefined}
                      placeholder="先创建一个环境"
                      options={data.environments
                        .filter((e: any) => !e.archived_at || e.id === selected)
                        .map((e: any) => ({
                          value: e.id,
                          label: e.name + (e.archived_at ? "（已归档）" : ""),
                        }))}
                      onChange={(value) => {
                        const next = new URLSearchParams(search);
                        next.set("env", value);
                        next.delete("run");
                        next.delete("chat");
                        next.delete("page");
                        setSearch(next);
                      }}
                    />
                    <Typography.Text
                      type="secondary"
                      ellipsis
                      style={{ maxWidth: 360 }}
                    >
                      {env?.base_url}
                    </Typography.Text>
                  </Space>
                  <Button
                    onClick={() => navigate(`/projects/${pid}/environments`)}
                  >
                    管理环境
                  </Button>
                </div>
                {data.project.archived_at && (
                  <Alert
                    type="warning"
                    showIcon
                    title="项目已归档，所有资产和报告仍可查看。请在项目管理中恢复后继续编辑。"
                  />
                )}
                {env?.archived_at && (
                  <Alert
                    type="warning"
                    showIcon
                    title="当前环境已归档，不能新建或执行测试。"
                  />
                )}
                {runId ? (
                  <RunDetail
                    id={runId}
                    pid={pid}
                    canEdit={
                      data.role !== "viewer" && !data.project.archived_at
                    }
                    onBack={() => {
                      const p = new URLSearchParams(search);
                      p.delete("run");
                      setSearch(p);
                    }}
                  />
                ) : section === "agent" ? (
                  <AgentChat
                    key={pid + "/" + selected}
                    pid={pid}
                    eid={selected}
                    workspace={data}
                  />
                ) : valid ? (
                  <Resources
                    key={pid + "/" + section + "/" + selected}
                    pid={pid}
                    section={section!}
                    eid={selected}
                    workspace={data}
                  />
                ) : (
                  <Navigate to={`/projects/${pid}/environments`} replace />
                )}
              </>
            )}
          </Suspense>
        </Layout.Content>
        <Layout.Footer className="admin-footer">
          LoopLab · 测试资产属于项目，执行配置属于环境
        </Layout.Footer>
      </Layout>
    </Layout>
  );
}
