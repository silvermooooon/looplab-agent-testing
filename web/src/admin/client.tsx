import { QueryClient, useQuery } from "@tanstack/react-query";
import { Alert, Button, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const r = await fetch("/api" + path, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (r.status === 401 && !path.startsWith("/auth/"))
    queryClient.setQueryData(["session"], { user: null });
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data;
}
export function useApi(key: readonly unknown[], path: string, enabled = true) {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(path, "GET", undefined, signal),
    enabled,
  });
}
export const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  completed: "已回复",
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读成员",
};
export function Status({ value }: { value: string }) {
  return (
    <Tag
      color={
        {
          passed: "success",
          failed: "error",
          running: "processing",
          queued: "warning",
        }[value]
      }
    >
      {statusNames[value] || value}
    </Tag>
  );
}
export const date = (v: string) =>
  v ? new Date(v).toLocaleString("zh-CN") : "—";
export function Heading({
  title,
  note,
  actions,
}: {
  title: string;
  note: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <Typography.Title level={2}>{title}</Typography.Title>
        <Typography.Text type="secondary">{note}</Typography.Text>
      </div>
      <Space wrap>{actions}</Space>
    </div>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  return error ? (
    <Alert
      type="error"
      showIcon
      title={error.message}
      action={retry && <Button onClick={retry}>重试</Button>}
    />
  ) : null;
}
