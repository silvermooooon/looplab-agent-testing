import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Input,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { MessageSquare, RefreshCw, Upload as UploadIcon } from "lucide-react";
import { api, date, Failure, Heading } from "./client";

export default function FileLibrary({
  pid,
  eid,
  workspace,
}: {
  pid: string;
  eid: string;
  workspace: any;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [uploading, setUploading] = useState(false);
  const env = workspace.environments.find((item: any) => item.id === eid);
  const canEdit = workspace.role !== "viewer" && !workspace.project.archived_at;
  const canChat = canEdit && !!env && !env.archived_at;
  const files = useQuery({
    queryKey: ["project-files", pid, page, search, archived],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/files?page=${page}&pageSize=20&q=${encodeURIComponent(search)}&archived=${archived}`,
        "GET",
        undefined,
        signal,
      ),
  });
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["project-files", pid] });
  const upload = async (incoming: File[]) => {
    if (!canEdit || uploading) return;
    setUploading(true);
    try {
      for (const file of incoming) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error(`${file.name} 超过 10 MB`);
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api(`/projects/${pid}/files`, "POST", {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data: encoded,
        });
      }
      setPage(1);
      await refresh();
      message.success(`已上传 ${incoming.length} 个文件`);
    } catch (error) {
      await refresh();
      message.error((error as Error).message);
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <Heading
        title="测试文件库"
        note="将测试数据、文档和其他输入文件保存在项目中，供团队、Agent 和各环境的测试流程复用。"
        actions={
          <Upload
            multiple
            showUploadList={false}
            disabled={!canEdit || uploading}
            beforeUpload={(file, list) => {
              if (file === list[0]) void upload(list);
              return false;
            }}
          >
            <Button
              type="primary"
              icon={<UploadIcon size={16} />}
              loading={uploading}
              disabled={!canEdit}
            >
              上传测试文件
            </Button>
          </Upload>
        }
      />
      {workspace.role === "viewer" && (
        <Alert
          type="info"
          showIcon
          title="你拥有只读权限，可以查看和下载文件。"
        />
      )}
      <div className="table-card">
        <Space wrap style={{ display: "flex", marginBottom: 16 }}>
          <Input.Search
            aria-label="搜索测试文件"
            placeholder="搜索文件名"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 260 }}
          />
          <Segmented
            options={["使用中", "已归档"]}
            value={archived ? "已归档" : "使用中"}
            onChange={(value) => {
              setPage(1);
              setArchived(value === "已归档");
            }}
          />
          <Button
            aria-label="刷新测试文件"
            icon={<RefreshCw size={15} />}
            loading={files.isFetching}
            onClick={() => void files.refetch()}
          />
        </Space>
        <Failure error={files.error} retry={() => void files.refetch()} />
        <Table
          rowKey="id"
          loading={files.isFetching}
          dataSource={files.data?.items || []}
          scroll={{ x: 820 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: files.data?.total || 0,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 个文件`,
            onChange: (next) => setPage(next),
          }}
          columns={[
            {
              title: "文件名称",
              dataIndex: "name",
              render: (name: string) => (
                <Typography.Text strong>{name}</Typography.Text>
              ),
            },
            {
              title: "类型",
              dataIndex: "mime_type",
              render: (type: string) => (
                <Tag>{type || "application/octet-stream"}</Tag>
              ),
            },
            {
              title: "大小",
              dataIndex: "size",
              render: (size: number) =>
                size === 0
                  ? "0 B"
                  : size >= 1024 * 1024
                    ? `${(size / (1024 * 1024)).toFixed(2)} MB`
                    : `${Math.max(1, Math.ceil(size / 1024))} KB`,
            },
            { title: "上传时间", dataIndex: "created_at", render: date },
            {
              title: "操作",
              render: (_: any, row: any) => (
                <Space wrap>
                  <a
                    href={`/api/projects/${pid}/files/${row.id}/download`}
                    download
                  >
                    下载
                  </a>
                  {!archived && (
                    <Button
                      type="link"
                      icon={<MessageSquare size={14} />}
                      disabled={!canChat}
                      onClick={() =>
                        navigate(
                          `/projects/${pid}/agent?env=${eid}&file=${row.id}`,
                        )
                      }
                    >
                      在 Agent 中使用
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      type="link"
                      danger={!archived}
                      onClick={() =>
                        modal.confirm({
                          title: `${archived ? "恢复" : "归档"}文件「${row.name}」？`,
                          content: archived
                            ? "恢复后，文件会重新出现在文件选择列表中。"
                            : "已引用此文件的流程仍可使用；归档后不再出现在新的文件选择列表中。",
                          okText: archived ? "恢复" : "归档",
                          cancelText: "取消",
                          onOk: async () => {
                            try {
                              await api(
                                `/projects/${pid}/files/${row.id}`,
                                "PATCH",
                                { archived: !archived },
                              );
                              await refresh();
                              message.success(
                                archived ? "文件已恢复" : "文件已归档",
                              );
                            } catch (error) {
                              message.error((error as Error).message);
                              throw error;
                            }
                          },
                        })
                      }
                    >
                      {archived ? "恢复" : "归档"}
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
