import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Image,
  Space,
  Spin,
  Table,
  Typography,
} from "antd";
import { ArrowLeft, Download } from "lucide-react";
import { api, date, Failure, Heading, Status } from "./client";
import BrowserPreview, { describeBrowserAction } from "./BrowserPreview";
import InterventionPanel, { useIntervention } from "./Intervention";
export default function RunDetail({
  id,
  pid,
  canEdit,
  onBack,
}: {
  id: string;
  pid: string;
  canEdit: boolean;
  onBack: () => void;
}) {
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [cancelling, setCancelling] = useState(false);
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: async ({ signal }) => {
      const old = cache.getQueryData<any>(["run", id]);
      const next = await api(
        `/runs/${id}?incremental=true&after=${old?.nextCursor || 0}`,
        "GET",
        undefined,
        signal,
      );
      return { ...next, events: [...(old?.events || []), ...next.events] };
    },
    refetchInterval: (q) =>
      q.state.data?.hasMore
        ? 100
        : q.state.data &&
            ["queued", "running"].includes(q.state.data.run.status)
          ? 1500
          : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  });
  const status = run.data?.run.status;
  const intervention = useIntervention(
    id,
    ["queued", "running"].includes(status),
  );
  const eventNames: Record<string, string> = {
    run_started: "运行开始",
    node_start: "开始节点",
    node_passed: "节点通过",
    step: "浏览器步骤",
    artifact: "保存附件",
    run_passed: "运行通过",
    run_failed: "运行失败",
    run_cancelled: "已取消",
    agent_tool_start: "Agent 调用工具",
    agent_tool_end: "Agent 工具完成",
    agent_text: "流式回复",
    agent_message: "Agent 回复",
    agent_status: "Agent 进度",
    conversation_completed: "对话完成",
    node_saved: "保存节点",
    flow_saved: "保存流程",
    knowledge_loaded: "加载项目知识",
    knowledge_saved: "保存知识文档",
    personal_memory_loaded: "加载个人记忆",
    personal_memory_saved: "更新个人记忆",
    personal_memory_unavailable: "个人记忆暂不可用",
    intervention: "人工接管状态",
    intervention_action: "人工操作",
    jira_issue_saved: "保存 Jira 需求",
    jira_published: "Jira 回写已核验",
    jira_transitioned: "Jira 状态已核验",
    case_saved: "保存测试用例",
    flow_execution: "测试流程执行结果",
  };
  useEffect(() => {
    if (status && !["queued", "running"].includes(status)) {
      void cache.invalidateQueries({ queryKey: ["resources", pid] });
      void cache.invalidateQueries({ queryKey: ["jira", pid] });
    }
  }, [status, cache, pid]);
  if (run.error)
    return <Failure error={run.error} retry={() => void run.refetch()} />;
  if (!run.data) return <Spin />;
  const data = run.data,
    r = data.run,
    active = ["queued", "running"].includes(r.status);
  return (
    <>
      <Button type="text" icon={<ArrowLeft size={16} />} onClick={onBack}>
        返回列表
      </Button>
      <Heading
        title={"执行报告 · " + (r.case_title || id.slice(0, 8))}
        note={r.summary || "任务已进入共享队列，运行中的事件会自动更新。"}
        actions={
          <>
            <Status value={r.status} />
            <BrowserPreview key={id} id={id} status={r.status} />
            {active && canEdit && (
              <Button
                danger
                loading={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try {
                    await api(`/runs/${id}/cancel`, "POST");
                    await run.refetch();
                  } catch (e) {
                    message.error((e as Error).message);
                  } finally {
                    setCancelling(false);
                  }
                }}
              >
                取消运行
              </Button>
            )}
            <Button
              disabled={data.hasMore}
              icon={<Download size={15} />}
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `run-${id}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              导出报告
            </Button>
          </>
        }
      />
      {active && intervention.data?.active && intervention.data.info && (
        <InterventionPanel
          id={id}
          canEdit={canEdit}
          info={intervention.data.info}
        />
      )}
      {r.error && <Alert type="error" showIcon title={r.error} />}
      <div className="table-card">
        <Descriptions
          size="small"
          items={[
            {
              key: "mode",
              label: "执行方式",
              children: (
                {
                  generate: "Agent 生成",
                  execute: "脚本重放",
                  repair: "节点修复",
                } as any
              )[r.mode],
            },
            { key: "start", label: "创建时间", children: date(r.created_at) },
            { key: "end", label: "完成时间", children: date(r.finished_at) },
          ]}
        />
        <Typography.Title level={4}>执行事件</Typography.Title>
        <Table<any>
          size="small"
          rowKey="id"
          dataSource={data.events}
          scroll={{ x: 600 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: false,
            showTotal: (n) => `${n} 条事件`,
          }}
          expandable={{
            expandedRowRender: (e) => (
              <pre className="code-preview">
                {JSON.stringify(e.data, null, 2)}
              </pre>
            ),
          }}
          columns={[
            {
              title: "时间",
              dataIndex: "created_at",
              width: 190,
              render: date,
            },
            {
              title: "事件",
              dataIndex: "kind",
              width: 220,
              render: (kind: string) => eventNames[kind] || kind,
            },
            {
              title: "详情",
              render: (_, e) => (
                <Typography.Text ellipsis style={{ maxWidth: 420 }}>
                  {(e.kind === "step"
                    ? `${e.data.name} · ${describeBrowserAction(e.data.step?.action, e.data.step?.selector)} · ${e.data.status}`
                    : null) ||
                    (e.kind === "agent_tool_start" &&
                    e.data.name === "browser_action" &&
                    e.data.args?.step?.action
                      ? describeBrowserAction(
                          e.data.args.step.action,
                          e.data.args.step.selector,
                        )
                      : null) ||
                    (e.kind === "knowledge_saved" ? e.data.title : null) ||
                    e.data?.message ||
                    e.data?.name ||
                    e.data?.error ||
                    JSON.stringify(e.data).slice(0, 180)}
                </Typography.Text>
              ),
            },
          ]}
        />
        {data.hasMore && (
          <Typography.Text type="secondary">正在读取剩余事件…</Typography.Text>
        )}
      </div>
      <Typography.Title level={4}>截图与附件</Typography.Title>
      <div className="run-images">
        <Image.PreviewGroup>
          {data.artifacts.map((a: any) => (
            <div key={a.id}>
              {a.mime_type.startsWith("image/") ? (
                <Image
                  src={`/api/artifacts/${a.id}`}
                  alt={a.name}
                  loading="lazy"
                />
              ) : (
                <a href={`/api/artifacts/${a.id}`}>{a.name}</a>
              )}
              <Typography.Paragraph type="secondary">
                {a.name}
              </Typography.Paragraph>
            </div>
          ))}
        </Image.PreviewGroup>
      </div>
    </>
  );
}
