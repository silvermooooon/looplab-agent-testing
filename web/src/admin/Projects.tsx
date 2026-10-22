import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Plus, RefreshCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, date, Failure, Heading, Status, useApi } from "./client";
export default function Projects() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page")) || 1,
    q = params.get("q") || "",
    archived = params.get("archived") === "true";
  const [editor, setEditor] = useState<any>(null),
    [form] = Form.useForm();
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const list = useApi(
    ["projects", page, q, archived],
    `/manage/projects?page=${page}&q=${encodeURIComponent(q)}&archived=${archived}`,
  );
  const update = (values: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), ...values });
  const save = useMutation({
    mutationFn: (v: any) =>
      api(
        editor.id ? `/projects/${editor.id}` : "/projects",
        editor.id ? "PUT" : "POST",
        v,
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["projects"] });
      await cache.invalidateQueries({ queryKey: ["workspace"] });
      setEditor(null);
      message.success("项目已保存");
    },
  });
  const archive = async (p: any) => {
    await api(`/projects/${p.id}/archive`, "POST", { archived: !archived });
    await cache.invalidateQueries({ queryKey: ["projects"] });
    await cache.invalidateQueries({ queryKey: ["workspace", p.id] });
    message.success(archived ? "项目已恢复" : "项目已归档");
  };
  function open(p: any = {}) {
    save.reset();
    setEditor(p);
    form.setFieldsValue({
      name: p.name || "",
      description: p.description || "",
    });
  }
  return (
    <>
      <Heading
        title="项目管理"
        note="为每个被测系统建立独立项目，与团队共享知识、节点和测试流程。"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => open()}
          >
            创建项目
          </Button>
        }
      />
      <div className="table-card">
        <div className="list-toolbar">
          <Input.Search
            aria-label="搜索项目"
            placeholder="搜索项目名称或说明"
            defaultValue={q}
            allowClear
            onSearch={(v) => update({ q: v, page: "1" })}
            style={{ maxWidth: 340 }}
          />
          <Space>
            <Segmented
              value={archived ? "已归档" : "进行中"}
              options={["进行中", "已归档"]}
              onChange={(v) =>
                update({ archived: String(v === "已归档"), page: "1" })
              }
            />
            <Button
              aria-label="刷新项目"
              icon={<RefreshCw size={15} />}
              loading={list.isFetching}
              onClick={() => void list.refetch()}
            />
          </Space>
        </div>
        <Failure error={list.error} retry={() => void list.refetch()} />
        <Table<any>
          rowKey="id"
          loading={list.isPending}
          dataSource={list.data?.items}
          scroll={{ x: 800 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: list.data?.total,
            showSizeChanger: false,
            showTotal: (n) => `共 ${n} 个项目`,
            onChange: (p) => update({ page: String(p) }),
          }}
          columns={[
            {
              title: "项目",
              dataIndex: "name",
              render: (_, p) => (
                <>
                  <Link to={`/projects/${p.id}/environments`}>
                    <Typography.Text strong>{p.name}</Typography.Text>
                  </Link>
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis={{ rows: 2 }}
                    style={{ margin: "4px 0 0", maxWidth: 360 }}
                  >
                    {p.description || "暂无项目说明"}
                  </Typography.Paragraph>
                </>
              ),
            },
            { title: "环境", dataIndex: "environment_count", width: 90 },
            { title: "成员", dataIndex: "member_count", width: 90 },
            {
              title: "我的角色",
              dataIndex: "role",
              render: (r) => <Status value={r} />,
            },
            { title: "创建时间", dataIndex: "created_at", render: date },
            {
              title: "操作",
              width: 230,
              render: (_, p) => (
                <Space>
                  <Link to={`/projects/${p.id}/environments`}>进入项目</Link>
                  {p.role === "owner" && (
                    <>
                      {!archived && (
                        <Button type="link" onClick={() => open(p)}>
                          编辑
                        </Button>
                      )}
                      <Button
                        type="link"
                        danger={!archived}
                        onClick={() =>
                          modal.confirm({
                            title: `${archived ? "恢复" : "归档"}「${p.name}」？`,
                            content: archived
                              ? "恢复后可以继续创建和执行测试。"
                              : "归档后禁止写入，历史资产和报告保留，可随时恢复。",
                            okText: archived ? "恢复项目" : "归档项目",
                            cancelText: "取消",
                            onOk: () =>
                              archive(p).catch((e) => {
                                message.error(e.message);
                                throw e;
                              }),
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
          ]}
        />
      </div>
      <Modal
        open={!!editor}
        title={editor?.id ? "编辑项目" : "创建项目"}
        onCancel={() => setEditor(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText="保存项目"
        cancelText="取消"
        destroyOnHidden
      >
        <Failure error={save.error} />
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, whitespace: true, message: "请输入项目名称" },
              { max: 120 },
            ]}
          >
            <Input autoFocus placeholder="例如：客户服务 Agent" />
          </Form.Item>
          <Form.Item
            name="description"
            label="项目说明"
            rules={[{ max: 4000 }]}
          >
            <Input.TextArea
              rows={4}
              placeholder="说明被测系统的用途与测试范围"
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
