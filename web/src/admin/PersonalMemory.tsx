import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Input, Space, Spin, Tag, Typography } from "antd";
import { api, Failure, Heading } from "./client";

type Memory = { content: string; version: string | null };

export default function PersonalMemory({ userId }: { userId: string }) {
  const { message, modal } = App.useApp();
  const cache = useQueryClient();
  const queryKey = ["personal-memory", userId] as const;
  const [draft, setDraft] = useState<Memory | null>(null);
  const memory = useQuery<Memory>({
    queryKey,
    queryFn: ({ signal }) => api("/me/memory", "GET", undefined, signal),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const save = useMutation({
    mutationFn: (value: Memory): Promise<Memory> =>
      api("/me/memory", "PUT", value),
    onSuccess: (saved) => {
      cache.setQueryData(queryKey, saved);
      setDraft(null);
      message.success(saved.content ? "个人记忆已保存" : "个人记忆已清空");
    },
  });
  const latest = memory.data;
  const editing = draft ?? latest;
  const busy = save.isPending || memory.isFetching;
  const conflicted = !!draft && !!latest && draft.version !== latest.version;

  return (
    <>
      <Heading
        title="个人记忆"
        note="在不同项目中沿用你的测试偏好与工作习惯。"
      />
      <div className="table-card" style={{ maxWidth: 960 }}>
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="保存长期适用的测试偏好"
            description="你也可以在 Agent 对话中说「以后在所有项目里，先做冒烟测试，再展开回归测试，请记住这个习惯」。页面定位、接口约定等项目事实仍保存到项目知识库。个人记忆按账号存放在当前服务器，可用于调整共享项目中的 Agent 回复和测试产出。"
          />
          <div className="list-toolbar">
            <Typography.Text strong>个人记忆内容</Typography.Text>
            <Space wrap>
              {latest && (
                <Tag title={latest.version ?? undefined}>
                  {latest.version
                    ? `版本 ${latest.version.slice(0, 8)}`
                    : "暂无版本"}
                </Tag>
              )}
              <Button
                aria-label="重新读取个人记忆"
                loading={memory.isFetching}
                disabled={save.isPending}
                onClick={() => {
                  save.reset();
                  void memory.refetch();
                }}
              >
                重新读取
              </Button>
            </Space>
          </div>
          <Failure error={memory.error} />
          {save.error && (
            <Alert
              type="error"
              showIcon
              title={save.error.message}
              description="当前编辑已保留。可以重新读取服务器版本，再核对修改。"
            />
          )}
          {memory.isPending && <Spin />}
          {editing && latest && (
            <>
              <Input.TextArea
                aria-label="个人记忆内容"
                value={editing.content}
                placeholder="例如：生成测试用例时，先列出关键路径，再按风险补充边界条件。"
                maxLength={6000}
                showCount
                rows={12}
                disabled={save.isPending}
                onChange={(event) => {
                  const content = event.target.value;
                  setDraft(
                    content === latest.content ? null : { ...editing, content },
                  );
                }}
              />
              {conflicted && (
                <Alert
                  type="warning"
                  showIcon
                  title="服务器上的记忆已有新版本，当前草稿已保留"
                  description={
                    <Space orientation="vertical" style={{ width: "100%" }}>
                      <Input.TextArea
                        aria-label="服务器最新个人记忆"
                        value={latest.content}
                        placeholder="服务器上的个人记忆为空"
                        readOnly
                        rows={4}
                      />
                      <Typography.Text>
                        请核对新版本和草稿后选择。保存草稿会以草稿内容替换当前记忆。
                      </Typography.Text>
                      <Space wrap>
                        <Button onClick={() => setDraft(null)}>
                          使用服务器内容
                        </Button>
                        <Button
                          onClick={() =>
                            setDraft({ ...editing, version: latest.version })
                          }
                        >
                          保留草稿继续编辑
                        </Button>
                      </Space>
                    </Space>
                  }
                />
              )}
              <Space wrap>
                <Button
                  type="primary"
                  disabled={
                    busy || conflicted || editing.content === latest.content
                  }
                  loading={save.isPending}
                  onClick={() => save.mutate(editing)}
                >
                  保存个人记忆
                </Button>
                <Button
                  danger
                  disabled={busy || conflicted || !latest.content}
                  onClick={() =>
                    modal.confirm({
                      title: "清空个人记忆？",
                      content:
                        "Agent 将停止使用当前记忆。先前的版本仍保存在 Git 历史中。",
                      okText: "确认清空",
                      okButtonProps: { danger: true },
                      onOk: () =>
                        save.mutate({ content: "", version: latest.version }),
                    })
                  }
                >
                  清空个人记忆
                </Button>
              </Space>
            </>
          )}
        </Space>
      </div>
    </>
  );
}
