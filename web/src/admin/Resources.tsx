import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Alert,
  Button,
  Drawer,
  Input,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Plus, RefreshCw } from "lucide-react";
import { api, date, Failure, Heading, Status } from "./client";
const Editor = lazy(() => import("./ResourceEditor"));
const titles: Record<string, [string, string, string]> = {
  environments: [
    "环境管理",
    "为开发、预发布和生产分别配置地址、变量与凭据。节点和流程按环境隔离。",
    "创建环境",
  ],
  cases: [
    "测试用例",
    "描述目标和预期结果，让 Agent 探索页面、复用节点并生成可重放的流程。",
    "新建用例",
  ],
  nodes: [
    "共享节点",
    "复用登录、发送消息和断言等步骤。每次修改生成新版本，既有流程保持稳定。",
    "创建节点",
  ],
  flows: [
    "测试流程",
    "按顺序组合节点并填写参数，保存后可以直接重放或导出 TypeScript。",
    "编排流程",
  ],
  knowledge: [
    "知识库",
    "向 Agent 提供项目背景、页面说明、操作约定与预期行为。",
    "添加知识",
  ],
  runs: [
    "运行记录",
    "按当前环境查看执行状态、事件和截图。只有运行中的任务会自动刷新。",
    "",
  ],
  team: [
    "项目成员",
    "所有者管理成员；编辑者维护和执行测试；只读成员查看资产与报告。",
    "添加成员",
  ],
};
export default function Resources({
  pid,
  section,
  eid,
  workspace,
}: {
  pid: string;
  section: string;
  eid: string;
  workspace: any;
}) {
  const [params, setParams] = useSearchParams(),
    [editor, setEditor] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [actionBusy, setActionBusy] = useState(false);
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const page = Number(params.get("page")) || 1,
    q = params.get("q") || "",
    archived = params.get("archived") === "true";
  const env = workspace.environments.find((e: any) => e.id === eid);
  const edit = workspace.role !== "viewer" && !workspace.project.archived_at;
  const envEdit = edit && !!env && !env.archived_at;
  const allowed =
    section === "team"
      ? workspace.role === "owner" && !workspace.project.archived_at
      : ["nodes", "flows"].includes(section)
        ? envEdit
        : edit;
  const list = useQuery({
    queryKey: ["resources", pid, section, eid, page, q, archived],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/resources/${section}?page=${page}&q=${encodeURIComponent(q)}&archived=${archived}${eid ? "&environmentId=" + eid : ""}`,
        "GET",
        undefined,
        signal,
      ),
    refetchInterval: (query) =>
      section === "runs" &&
      query.state.data?.items.some((r: any) =>
        ["queued", "running"].includes(r.status),
      )
        ? 2500
        : false,
    refetchIntervalInBackground: false,
  });
  const update = (v: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), ...v });
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["resources", pid] });
    await cache.invalidateQueries({ queryKey: ["workspace", pid] });
  };
  const perform = async (fn: () => Promise<void>) => {
    setActionBusy(true);
    try {
      await fn();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };
  const open = (kind: string, item?: any) => setEditor({ kind, item });
  const start = async (mode: string, row: any) => {
    const r = await api(`/projects/${pid}/runs`, "POST", {
      environmentId: eid,
      caseId: row.case_id || row.id,
      mode,
      flowId: mode === "execute" ? row.id : undefined,
    });
    await refresh();
    update({ run: r.id });
  };
  let columns: any[] = [];
  if (section === "environments")
    columns = [
      {
        title: "环境",
        dataIndex: "name",
        render: (v: string, r: any) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{v}</Typography.Text>
            {r.id === eid && <Tag color="green">当前环境</Tag>}
          </Space>
        ),
      },
      {
        title: "部署地址",
        dataIndex: "base_url",
        render: (v: string) => (
          <Typography.Text copyable ellipsis style={{ maxWidth: 340 }}>
            {v}
          </Typography.Text>
        ),
      },
      {
        title: "配置",
        render: (_: any, r: any) => (
          <Space>
            <Tag>{Object.keys(r.variables).length} 个变量</Tag>
            <Tag>{r.secretKeys.length} 个凭据</Tag>
          </Space>
        ),
      },
      {
        title: "操作",
        width: 330,
        render: (_: any, r: any) => (
          <Space wrap>
            <Button
              type="link"
              onClick={() => update({ env: r.id, page: "1" })}
            >
              切换环境
            </Button>
            {edit && (
              <>
                {!archived && (
                  <>
                    <Button type="link" onClick={() => open("environments", r)}>
                      编辑配置
                    </Button>
                    <Button type="link" onClick={() => open("clone", r)}>
                      复制环境
                    </Button>
                  </>
                )}
                <Button
                  type="link"
                  danger={!archived}
                  onClick={() =>
                    modal.confirm({
                      title: `${archived ? "恢复" : "归档"}环境「${r.name}」？`,
                      content:
                        "环境中的节点、流程和报告会保留。归档后不再接受新任务。",
                      okText: archived ? "恢复" : "归档",
                      cancelText: "取消",
                      onOk: async () => {
                        try {
                          await api(
                            `/projects/${pid}/environments/${r.id}/archive`,
                            "POST",
                            { archived: !archived },
                          );
                          await refresh();
                        } catch (e) {
                          message.error((e as Error).message);
                          throw e;
                        }
                      },
                    })
                  }
                >
                  {archived ? "恢复" : "归档"}
                </Button>
              </>
            )}
          </Space>
        ),
      },
    ];
  if (section === "cases")
    columns = [
      {
        title: "测试用例",
        dataIndex: "title",
        render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
      },
      { title: "测试说明", dataIndex: "instructions", ellipsis: true },
      { title: "创建时间", dataIndex: "created_at", render: date },
      {
        title: "操作",
        render: (_: any, r: any) => (
          <Space>
            <Button
              type="link"
              onClick={() =>
                setDetail({ title: r.title, text: r.instructions })
              }
            >
              查看
            </Button>
            {edit && (
              <Button type="link" onClick={() => open("cases", r)}>
                编辑
              </Button>
            )}
            <Button
              type="primary"
              size="small"
              disabled={!envEdit || actionBusy}
              onClick={() => void perform(() => start("generate", r))}
            >
              Agent 生成并验证
            </Button>
          </Space>
        ),
      },
    ];
  if (section === "nodes")
    columns = [
      {
        title: "节点",
        dataIndex: "name",
        render: (v: string, r: any) => (
          <Space direction="vertical" size={1}>
            <b>{v}</b>
            <Typography.Text type="secondary">{r.key}</Typography.Text>
          </Space>
        ),
      },
      {
        title: "版本",
        dataIndex: "version",
        render: (v: number) => <Tag color="green">v{v}</Tag>,
      },
      { title: "说明", dataIndex: "description", ellipsis: true },
      { title: "步骤", render: (_: any, r: any) => r.spec.steps.length },
      {
        title: "操作",
        render: (_: any, r: any) => (
          <Space>
            <Button
              type="link"
              onClick={() =>
                void perform(async () => {
                  const versions = await api(
                    `/projects/${pid}/nodes/${r.node_id}/versions`,
                  );
                  setDetail({
                    title: r.name + " · 版本历史",
                    versions: versions.filter(
                      (v: any) => v.environment_id === eid,
                    ),
                  });
                })
              }
            >
              版本历史
            </Button>
            {envEdit && (
              <>
                <Button type="link" onClick={() => open("nodes", r)}>
                  编辑新版本
                </Button>
                <Button type="link" onClick={() => open("repair", r)}>
                  Agent 修复
                </Button>
              </>
            )}
          </Space>
        ),
      },
    ];
  if (section === "flows")
    columns = [
      {
        title: "流程名称",
        dataIndex: "name",
        render: (v: string) => <b>{v}</b>,
      },
      { title: "测试用例", dataIndex: "case_title" },
      { title: "节点数", render: (_: any, r: any) => r.steps.length },
      { title: "创建时间", dataIndex: "created_at", render: date },
      {
        title: "操作",
        render: (_: any, r: any) => (
          <Space>
            <Button type="link" onClick={() => open("flows", r)}>
              {envEdit ? "编辑副本" : "查看步骤"}
            </Button>
            <a href={`/api/projects/${pid}/flows/${r.id}/export`} download>
              导出脚本
            </a>
            <Button
              type="primary"
              size="small"
              disabled={!envEdit || actionBusy}
              onClick={() => void perform(() => start("execute", r))}
            >
              重放
            </Button>
          </Space>
        ),
      },
    ];
  if (section === "knowledge")
    columns = [
      { title: "文档", dataIndex: "title", render: (v: string) => <b>{v}</b> },
      { title: "内容摘要", dataIndex: "content", ellipsis: true },
      { title: "更新时间", dataIndex: "updated_at", render: date },
      {
        title: "操作",
        render: (_: any, r: any) => (
          <Space>
            <Button
              type="link"
              onClick={() => setDetail({ title: r.title, text: r.content })}
            >
              阅读
            </Button>
            {edit && (
              <>
                <Button type="link" onClick={() => open("knowledge", r)}>
                  编辑
                </Button>
                <Button
                  type="link"
                  danger
                  onClick={() =>
                    modal.confirm({
                      title: "删除这条知识？",
                      okText: "删除",
                      cancelText: "取消",
                      onOk: async () => {
                        await api(
                          `/projects/${pid}/knowledge/${r.id}`,
                          "DELETE",
                        );
                        await refresh();
                      },
                    })
                  }
                >
                  删除
                </Button>
              </>
            )}
          </Space>
        ),
      },
    ];
  if (section === "team")
    columns = [
      { title: "成员", dataIndex: "name" },
      { title: "邮箱", dataIndex: "email" },
      {
        title: "权限",
        dataIndex: "role",
        render: (v: string) => <Status value={v} />,
      },
      {
        title: "操作",
        render: (_: any, r: any) =>
          allowed && r.role !== "owner" ? (
            <Space>
              <Button type="link" onClick={() => open("team", r)}>
                修改角色
              </Button>
              <Button
                type="link"
                danger
                onClick={() =>
                  modal.confirm({
                    title: `移除成员 ${r.name}？`,
                    okText: "移除",
                    cancelText: "取消",
                    onOk: async () => {
                      await api(`/projects/${pid}/members/${r.id}`, "DELETE");
                      await refresh();
                    },
                  })
                }
              >
                移除
              </Button>
            </Space>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
    ];
  if (section === "runs")
    columns = [
      { title: "测试用例", dataIndex: "case_title" },
      {
        title: "运行",
        dataIndex: "id",
        render: (v: string) => (
          <Button type="link" onClick={() => update({ run: v })}>
            {v.slice(0, 8)}
          </Button>
        ),
      },
      {
        title: "方式",
        dataIndex: "mode",
        render: (v: string) =>
          ({ generate: "生成", execute: "重放", repair: "修复" })[v],
      },
      {
        title: "状态",
        dataIndex: "status",
        render: (v: string) => <Status value={v} />,
      },
      { title: "结果", dataIndex: "summary", ellipsis: true },
      { title: "开始时间", dataIndex: "created_at", render: date },
      {
        title: "操作",
        render: (_: any, r: any) => (
          <Button type="link" onClick={() => update({ run: r.id })}>
            查看报告
          </Button>
        ),
      },
    ];
  const [title, note, create] = titles[section];
  return (
    <>
      <Heading
        title={title}
        note={note}
        actions={
          create && (
            <Button
              type="primary"
              icon={<Plus size={16} />}
              disabled={!allowed}
              onClick={() => open(section)}
            >
              {create}
            </Button>
          )
        }
      />
      {workspace.role === "viewer" && (
        <Alert
          type="info"
          showIcon
          title="你拥有只读权限。如需编辑配置或执行测试，请联系项目所有者。"
        />
      )}
      {!eid && ["cases", "nodes", "flows", "runs"].includes(section) && (
        <Alert
          type="info"
          showIcon
          title="请先在环境管理中创建一个环境，再生成或执行测试。"
        />
      )}
      <div className="table-card">
        <div className="list-toolbar">
          <Input.Search
            aria-label={`搜索${title}`}
            placeholder={`搜索${title}`}
            defaultValue={q}
            allowClear
            style={{ maxWidth: 340 }}
            onSearch={(v) => update({ q: v, page: "1" })}
          />
          <Space>
            {section === "environments" && (
              <Segmented
                options={["使用中", "已归档"]}
                value={archived ? "已归档" : "使用中"}
                onChange={(v) =>
                  update({ archived: String(v === "已归档"), page: "1" })
                }
              />
            )}
            <Button
              aria-label="刷新列表"
              loading={list.isFetching}
              icon={<RefreshCw size={15} />}
              onClick={() => void list.refetch()}
            />
          </Space>
        </div>
        <Failure error={list.error} retry={() => void list.refetch()} />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list.data?.items}
          loading={list.isPending}
          scroll={{ x: 850 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: list.data?.total,
            showSizeChanger: false,
            showTotal: (n) => `共 ${n} 条`,
            onChange: (p) => update({ page: String(p) }),
          }}
        />
      </div>
      {editor && (
        <Suspense fallback={<div>正在加载编辑器…</div>}>
          <Editor
            editor={editor}
            pid={pid}
            eid={eid}
            canEdit={allowed}
            onClose={() => setEditor(null)}
            onSaved={async (result) => {
              await refresh();
              setEditor(null);
              if (result?.runId) update({ run: result.runId });
              if (result?.environmentId) update({ env: result.environmentId });
              message.success("已保存");
            }}
          />
        </Suspense>
      )}
      <Drawer
        size={720}
        title={detail?.title}
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail?.text && (
          <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
            {detail.text}
          </Typography.Paragraph>
        )}
        {detail?.versions?.map((v: any) => (
          <div key={v.id}>
            <Tag>v{v.version}</Tag>
            <Typography.Text type="secondary">
              {date(v.created_at)}
            </Typography.Text>
            <pre className="code-preview">
              {JSON.stringify(v.spec, null, 2)}
            </pre>
          </div>
        ))}
      </Drawer>
    </>
  );
}
