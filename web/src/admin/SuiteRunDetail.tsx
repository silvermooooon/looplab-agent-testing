import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Progress,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import { ArrowLeft } from "lucide-react";
import { api, date, Failure, Heading, Status } from "./client";

export default function SuiteRunDetail({
  id,
  pid,
  canEdit,
  onBack,
  onOpenRun,
}: {
  id: string;
  pid: string;
  canEdit: boolean;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}) {
  const cache = useQueryClient();
  const { message } = App.useApp();
  const [cancelling, setCancelling] = useState(false);
  const result = useQuery({
    queryKey: ["suite-run", id],
    queryFn: ({ signal }) => api(`/suite-runs/${id}`, "GET", undefined, signal),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.run.status)
        ? 1500
        : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  });
  if (result.error)
    return <Failure error={result.error} retry={() => void result.refetch()} />;
  if (!result.data) return <Spin />;
  const { run, items } = result.data;
  const active = ["queued", "running"].includes(run.status);
  const finished =
    Number(run.passed_count) +
    Number(run.failed_count) +
    Number(run.cancelled_count);
  return (
    <>
      <Button
        type="text"
        icon={<ArrowLeft size={16} />}
        onClick={() => {
          void cache.invalidateQueries({ queryKey: ["suite-runs", pid] });
          onBack();
        }}
      >
        返回测试组
      </Button>
      <Heading
        title={`测试组报告 · ${run.suite_name || id.slice(0, 8)}`}
        note="按组内顺序逐一执行，失败后继续检查其余流程。点击单项可查看详细事件和截图。"
        actions={
          <>
            <Status value={run.status} />
            {active && canEdit && (
              <Button
                danger
                loading={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try {
                    await api(`/suite-runs/${id}/cancel`, "POST");
                    await result.refetch();
                  } catch (error) {
                    message.error((error as Error).message);
                  } finally {
                    setCancelling(false);
                  }
                }}
              >
                取消整组运行
              </Button>
            )}
          </>
        }
      />
      {run.error && <Alert type="error" showIcon title={run.error} />}
      <div className="table-card">
        <Descriptions
          size="small"
          items={[
            {
              key: "status",
              label: "总体状态",
              children: <Status value={run.status} />,
            },
            { key: "total", label: "流程总数", children: run.total_count },
            { key: "passed", label: "通过", children: run.passed_count },
            { key: "failed", label: "失败", children: run.failed_count },
            {
              key: "cancelled",
              label: "已取消",
              children: run.cancelled_count,
            },
            { key: "queued", label: "排队中", children: run.queued_count },
            { key: "running", label: "运行中", children: run.running_count },
            {
              key: "created",
              label: "创建时间",
              children: date(run.created_at),
            },
            {
              key: "finished",
              label: "完成时间",
              children: date(run.finished_at),
            },
          ]}
        />
        <Progress
          percent={
            run.total_count
              ? Math.round((finished * 100) / Number(run.total_count))
              : 0
          }
          status={
            active ? "active" : run.status === "failed" ? "exception" : "normal"
          }
        />
      </div>
      <div className="table-card" style={{ marginTop: 20 }}>
        <Table
          rowKey="id"
          dataSource={items}
          scroll={{ x: 850 }}
          pagination={false}
          columns={[
            { title: "顺序", dataIndex: "position" },
            { title: "流程", dataIndex: "flow_name" },
            { title: "测试用例", dataIndex: "case_title" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string, row: any) =>
                value === "cancelled" && !row.started_at ? (
                  <Tag>未执行</Tag>
                ) : (
                  <Status value={value} />
                ),
            },
            {
              title: "结果",
              render: (_: any, row: any) => row.summary || row.error || "—",
              ellipsis: true,
            },
            {
              title: "操作",
              render: (_: any, row: any) => (
                <Space>
                  <Button type="link" onClick={() => onOpenRun(row.id)}>
                    查看单项报告
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
