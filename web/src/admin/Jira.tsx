import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { RefreshCw } from "lucide-react";
import { api, date, Failure, Heading } from "./client";

export default function Jira({
  pid,
  eid,
  workspace,
}: {
  pid: string;
  eid: string;
  workspace: any;
}) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [stage, setStage] = useState<any>(null);
  const [site, setSite] = useState<any>(null);
  const [form] = Form.useForm();
  const [siteForm] = Form.useForm();
  const [siteError, setSiteError] = useState<Error | null>(null);
  const canEdit = workspace.role !== "viewer" && !workspace.project.archived_at;
  const env = workspace.environments.find((item: any) => item.id === eid);
  const canChat = canEdit && !!env && !env.archived_at;
  const data = useQuery({
    queryKey: ["jira", pid],
    staleTime: 0,
    queryFn: ({ signal }) =>
      api(`/projects/${pid}/jira`, "GET", undefined, signal),
  });
  const flows = useQuery({
    queryKey: ["jira-flows", pid, eid],
    staleTime: 0,
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/resources/flows?environmentId=${eid}&pageSize=100`,
        "GET",
        undefined,
        signal,
      ),
    enabled: stage?.kind === "run" && !!eid,
  });
  const runs = useQuery({
    queryKey: ["jira-runs", pid, eid],
    staleTime: 0,
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/resources/runs?environmentId=${eid}&pageSize=100`,
        "GET",
        undefined,
        signal,
      ),
    enabled: stage?.kind === "publish" && !!eid,
  });
  const issues = data.data?.issues || [];
  const cases = data.data?.cases || [];
  const publications = data.data?.publications || [];
  async function chat(text: string, caseId?: string) {
    setBusy(true);
    try {
      const session = await api(`/projects/${pid}/chat/sessions`, "POST", {
        environmentId: eid,
        title: text.slice(0, 80),
        ...(caseId ? { caseId } : {}),
      });
      sessionStorage.setItem(`looplab-draft:${pid}:${session.id}`, text);
      navigate(`/projects/${pid}/agent?env=${eid}&chat=${session.id}`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openStage(kind: string, issue: any) {
    form.resetFields();
    setStage({ kind, issue });
  }
  function editSite(adapter?: any) {
    const script = adapter?.script || data.data?.defaultScript;
    setSiteError(null);
    siteForm.setFieldsValue({
      origin: adapter?.origin || "",
      allowedOrigins: (script?.allowedOrigins || []).join("\n"),
      script: JSON.stringify(script || {}, null, 2),
    });
    setSite(adapter || {});
  }
  const linkedIds = new Set(
    cases
      .filter((item: any) => item.jira_issue_id === stage?.issue.id)
      .map((item: any) => item.id),
  );
  return (
    <>
      <Heading
        title="Jira 需求"
        note="通过本机浏览器读取需求，分阶段管理用例、流程和回写结果。每个入口都会进入 Agent 对话，可编辑请求后发送。"
      />
      {!canChat && canEdit && (
        <Alert
          type="info"
          showIcon
          title="请选择一个可用测试环境，再通过 Agent 操作 Jira。"
        />
      )}
      <div className="table-card">
        <Space.Compact style={{ width: "100%", marginBottom: 20 }}>
          <Input
            aria-label="Jira Ticket 链接"
            placeholder="粘贴 Jira Ticket 链接"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={!canChat || busy}
          />
          <Button
            type="primary"
            disabled={!canChat || !url.trim()}
            loading={busy}
            onClick={() =>
              void chat(
                `请通过浏览器读取这个 Jira Ticket：${url.trim()}。本轮只读取并保存需求快照，不创建或修改测试用例、流程，也不运行测试。`,
              )
            }
          >
            与 Agent 读取
          </Button>
        </Space.Compact>
        <Failure error={data.error} retry={() => void data.refetch()} />
        <Tabs
          items={[
            {
              key: "issues",
              label: "关联需求",
              children: (
                <Table
                  rowKey="id"
                  loading={data.isPending}
                  dataSource={issues}
                  scroll={{ x: 950 }}
                  pagination={{ pageSize: 20 }}
                  columns={[
                    {
                      title: "Ticket",
                      render: (_: any, item: any) => (
                        <Space orientation="vertical" size={1}>
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.issue_key}
                          </a>
                          <Typography.Text strong>{item.title}</Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: "Jira 状态",
                      dataIndex: "status",
                      render: (value: string) => <Tag>{value || "未读取"}</Tag>,
                    },
                    {
                      title: "关联用例",
                      render: (_: any, item: any) =>
                        cases.filter(
                          (testCase: any) => testCase.jira_issue_id === item.id,
                        ).length,
                    },
                    {
                      title: "读取时间",
                      dataIndex: "fetched_at",
                      render: date,
                    },
                    {
                      title: "操作",
                      render: (_: any, item: any) => (
                        <Space wrap>
                          <Button type="link" onClick={() => setDetail(item)}>
                            查看需求
                          </Button>
                          <Button
                            type="link"
                            disabled={!canChat || busy}
                            onClick={() =>
                              void chat(
                                `请重新读取 Jira ${item.url}。本轮只读取并更新需求快照，不创建或修改测试用例、流程，也不运行测试。`,
                              )
                            }
                          >
                            读取最新
                          </Button>
                          <Button
                            type="link"
                            disabled={!canChat || busy}
                            onClick={() =>
                              void chat(
                                `请根据项目中 Jira ${item.issue_key}（${item.url}）的需求生成测试用例，保存到项目并关联此 Ticket。先检查已有用例，保留已有人工修改。本轮完成用例整理。`,
                              )
                            }
                          >
                            生成用例
                          </Button>
                          <Button
                            type="link"
                            disabled={!canChat || busy}
                            onClick={() => openStage("run", item)}
                          >
                            运行流程
                          </Button>
                          <Button
                            type="link"
                            disabled={!canChat || busy}
                            onClick={() => openStage("publish", item)}
                          >
                            回写结果
                          </Button>
                          <Button
                            type="link"
                            disabled={!canChat || busy}
                            onClick={() => openStage("transition", item)}
                          >
                            调整状态
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: "publications",
              label: "回写记录",
              children: (
                <Table
                  rowKey="id"
                  dataSource={publications}
                  scroll={{ x: 800 }}
                  pagination={{ pageSize: 20 }}
                  columns={[
                    {
                      title: "Ticket",
                      render: (_: any, item: any) =>
                        issues.find((issue: any) => issue.id === item.issue_id)
                          ?.issue_key || item.issue_id,
                    },
                    {
                      title: "操作",
                      dataIndex: "operation",
                      render: (value: string) =>
                        value === "publish"
                          ? "回写测试结果"
                          : value === "transition"
                            ? "调整状态"
                            : value,
                    },
                    {
                      title: "结果",
                      dataIndex: "status",
                      render: (value: string) => (
                        <Tag color={value === "failed" ? "error" : "success"}>
                          {value === "verified" ? "已核验" : value}
                        </Tag>
                      ),
                    },
                    { title: "内容", dataIndex: "summary", ellipsis: true },
                    {
                      title: "来源运行",
                      render: (_: any, item: any) =>
                        item.run_id && (
                          <Link
                            to={`/projects/${pid}/runs?env=${eid}&run=${item.run_id}`}
                          >
                            {item.run_id.slice(0, 8)}
                          </Link>
                        ),
                    },
                    { title: "时间", dataIndex: "created_at", render: date },
                  ]}
                />
              ),
            },
            {
              key: "sites",
              label: "站点脚本",
              children: (
                <>
                  <Typography.Paragraph type="secondary">
                    管理已调查站点的页面定位规则。企业登录涉及其他域名时，可在站点配置中填写登录
                    origin。
                  </Typography.Paragraph>
                  <Button
                    disabled={!canEdit}
                    onClick={() => editSite()}
                    style={{ marginBottom: 12 }}
                  >
                    添加站点配置
                  </Button>
                  <Table
                    rowKey="origin"
                    dataSource={data.data?.adapters || []}
                    pagination={false}
                    columns={[
                      { title: "Jira 站点", dataIndex: "origin" },
                      {
                        title: "脚本版本",
                        dataIndex: "revision",
                        render: (value: number) => <Tag>v{value}</Tag>,
                      },
                      {
                        title: "登录域名",
                        render: (_: any, item: any) =>
                          item.script.allowedOrigins?.join("、") || "当前站点",
                      },
                      {
                        title: "操作",
                        render: (_: any, item: any) => (
                          <Button type="link" onClick={() => editSite(item)}>
                            {canEdit ? "编辑脚本" : "查看脚本"}
                          </Button>
                        ),
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
          tabBarExtraContent={
            <Button
              aria-label="刷新 Jira 数据"
              icon={<RefreshCw size={15} />}
              loading={data.isFetching}
              onClick={() => void data.refetch()}
            />
          }
        />
      </div>
      <Drawer
        title={detail ? `${detail.issue_key} · ${detail.title}` : "需求详情"}
        open={!!detail}
        onClose={() => setDetail(null)}
        size={760}
      >
        {detail && (
          <>
            <Typography.Paragraph>
              <a href={detail.url} target="_blank" rel="noreferrer">
                打开 Jira 原页面
              </a>
            </Typography.Paragraph>
            <Typography.Title level={5}>Story</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
              {detail.description || "未读取到描述"}
            </Typography.Paragraph>
            <Typography.Title level={5}>验收条件</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
              {detail.acceptance || "未读取到独立验收条件"}
            </Typography.Paragraph>
            <Typography.Title level={5}>评论快照</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
              {Array.isArray(detail.comments)
                ? detail.comments.join("\n\n")
                : detail.comments || "暂无评论"}
            </Typography.Paragraph>
            <Typography.Title level={5}>关联测试用例</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={cases.filter(
                (item: any) => item.jira_issue_id === detail.id,
              )}
              columns={[
                { title: "用例", dataIndex: "title" },
                {
                  title: "版本",
                  dataIndex: "version",
                  render: (version: number) => `v${version}`,
                },
                {
                  title: "操作",
                  render: (_: any, item: any) => (
                    <Space wrap>
                      <Link
                        to={`/projects/${pid}/cases?env=${eid}&q=${encodeURIComponent(item.title)}`}
                      >
                        查看与编辑
                      </Link>
                      <Button
                        type="link"
                        disabled={!canChat || busy}
                        onClick={() =>
                          void chat(
                            `请读取测试用例 ${item.id} 的当前版本 v${item.version}，根据当前内容调查被测环境，生成并保存可复用测试流程。本轮只保存脚本，稍后由我发起运行。`,
                            item.id,
                          )
                        }
                      >
                        编排脚本
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
      <Modal
        open={!!stage}
        title={
          stage?.kind === "run"
            ? "选择要运行的流程"
            : stage?.kind === "publish"
              ? "选择要回写的运行结果"
              : "调整 Jira 状态"
        }
        onCancel={() => setStage(null)}
        okText="在对话中继续"
        confirmLoading={busy}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            const issue = stage.issue;
            if (stage.kind === "run")
              void chat(
                `请运行流程 ${values.recordId}，它关联 Jira ${issue.issue_key}（${issue.url}）。本轮执行并核对测试结果。`,
              );
            else if (stage.kind === "publish")
              void chat(
                `请把运行 ${values.recordId} 的真实结果回写到 Jira ${issue.url}，提交后从页面核对结果。`,
              );
            else
              void chat(
                `请通过网页把 Jira ${issue.url} 的状态调整为“${values.targetStatus}”，操作前读取可用状态，完成后核对页面。`,
              );
          }}
        >
          {stage?.kind === "transition" ? (
            <Form.Item
              name="targetStatus"
              label="目标状态"
              rules={[{ required: true, message: "填写希望调整到的状态" }]}
            >
              <Input placeholder="例如 待验收" />
            </Form.Item>
          ) : (
            <Form.Item
              name="recordId"
              label={
                stage?.kind === "run"
                  ? "当前环境的关联流程"
                  : "当前环境的关联运行结果"
              }
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={
                  stage?.kind === "run" ? flows.isFetching : runs.isFetching
                }
                options={
                  stage?.kind === "run"
                    ? (flows.data?.items || [])
                        .filter((item: any) => linkedIds.has(item.case_id))
                        .map((item: any) => ({
                          value: item.id,
                          label: `${item.name} · 用例 v${item.case_version ?? "未知"}${item.case_version !== item.current_case_version ? "（用例已更新）" : ""} · ${item.id.slice(0, 8)}`,
                        }))
                    : (runs.data?.items || [])
                        .filter(
                          (item: any) =>
                            item.flow_id &&
                            item.events_complete &&
                            item.jira_issue_id === stage?.issue.id &&
                            ["passed", "failed", "cancelled"].includes(
                              item.status,
                            ),
                        )
                        .map((item: any) => ({
                          value: item.id,
                          label: `${item.case_title} · ${item.status} · ${item.id.slice(0, 8)}`,
                        }))
                }
              />
            </Form.Item>
          )}
          <Failure
            error={
              stage?.kind === "run"
                ? flows.error
                : stage?.kind === "publish"
                  ? runs.error
                  : null
            }
          />
        </Form>
      </Modal>
      <Modal
        open={!!site}
        title="Jira 站点脚本"
        width={760}
        onCancel={() => setSite(null)}
        okText="保存"
        okButtonProps={{ disabled: !canEdit }}
        confirmLoading={busy}
        onOk={() => siteForm.submit()}
      >
        <Failure error={siteError} />
        <Form
          form={siteForm}
          layout="vertical"
          disabled={!canEdit}
          onFinish={async (values) => {
            setBusy(true);
            setSiteError(null);
            try {
              await api(`/projects/${pid}/jira/sites`, "PUT", {
                origin: values.origin,
                allowedOrigins: values.allowedOrigins
                  .split(/\s+/)
                  .filter(Boolean),
                script: JSON.parse(values.script),
              });
              await data.refetch();
              setSite(null);
              message.success("站点脚本已保存");
            } catch (error) {
              setSiteError(error as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            label="Jira origin"
            name="origin"
            rules={[{ required: true }, { type: "url" }]}
          >
            <Input
              placeholder="https://jira.example.internal"
              disabled={!canEdit || !!site?.origin}
            />
          </Form.Item>
          <Form.Item label="允许的登录 origin，每行一个" name="allowedOrigins">
            <Input.TextArea
              rows={3}
              placeholder="https://login.example.internal"
            />
          </Form.Item>
          <Form.Item
            label="页面脚本配置"
            name="script"
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={14} spellCheck={false} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
