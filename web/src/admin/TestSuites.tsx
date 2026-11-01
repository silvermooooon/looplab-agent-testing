import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, date, Failure, flowCategories, Heading, Status } from "./client";

export default function TestSuites({
  pid,
  eid,
  workspace,
  onOpenRun,
}: {
  pid: string;
  eid: string;
  workspace: any;
  onOpenRun: (id: string) => void;
}) {
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const [editor, setEditor] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const env = workspace.environments.find((e: any) => e.id === eid);
  const canEdit =
    workspace.role !== "viewer" &&
    !workspace.project.archived_at &&
    !!env &&
    !env.archived_at;
  const suites = useQuery({
    queryKey: ["suites", pid, eid],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/suites?environmentId=${eid}`,
        "GET",
        undefined,
        signal,
      ),
    enabled: !!eid,
  });
  const history = useQuery({
    queryKey: ["suite-runs", pid, eid],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/suite-runs?environmentId=${eid}`,
        "GET",
        undefined,
        signal,
      ),
    enabled: !!eid,
    refetchInterval: (query) =>
      query.state.data?.items.some((r: any) =>
        ["queued", "running"].includes(r.status),
      )
        ? 2500
        : false,
    refetchIntervalInBackground: false,
  });
  const refresh = async () => {
    await Promise.all([suites.refetch(), history.refetch()]);
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading
        title="测试组"
        note="把当前环境中的流程按顺序组合，整组运行后查看汇总和每项报告。失败后会继续执行后续流程。"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            disabled={!canEdit}
            onClick={() => setEditor({})}
          >
            创建测试组
          </Button>
        }
      />
      {workspace.role === "viewer" && (
        <Alert
          type="info"
          showIcon
          title="你拥有只读权限。如需编辑或执行测试组，请联系项目所有者。"
        />
      )}
      {!eid && (
        <Alert
          type="info"
          showIcon
          title="请先在环境管理中创建一个环境，再创建测试组。"
        />
      )}
      <div className="table-card">
        <Space
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            测试组列表
          </Typography.Title>
          <Button
            aria-label="刷新测试组"
            icon={<RefreshCw size={15} />}
            loading={suites.isFetching}
            disabled={!eid}
            onClick={() => void refresh()}
          />
        </Space>
        <Failure error={suites.error} retry={() => void suites.refetch()} />
        <Table
          rowKey="id"
          loading={suites.isFetching}
          dataSource={suites.data?.items || []}
          scroll={{ x: 800 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: false,
            showTotal: (n) => `共 ${n} 条`,
          }}
          columns={[
            {
              title: "测试组名称",
              dataIndex: "name",
              render: (value: string) => <b>{value}</b>,
            },
            {
              title: "描述",
              dataIndex: "description",
              ellipsis: true,
              render: (value: string) => value || "—",
            },
            {
              title: "流程数",
              render: (_: any, row: any) => row.flow_ids?.length || 0,
            },
            { title: "更新时间", dataIndex: "updated_at", render: date },
            {
              title: "操作",
              render: (_: any, row: any) => (
                <Space wrap>
                  <Button
                    type="link"
                    disabled={!canEdit}
                    onClick={() => setEditor(row)}
                  >
                    编辑
                  </Button>
                  <Button
                    type="link"
                    danger
                    disabled={!canEdit || busy}
                    onClick={() =>
                      modal.confirm({
                        title: `删除测试组「${row.name}」？`,
                        content: "已完成的批次及单项运行报告会保留。",
                        okText: "删除",
                        cancelText: "取消",
                        onOk: async () => {
                          try {
                            await api(
                              `/projects/${pid}/suites/${row.id}`,
                              "DELETE",
                            );
                            await refresh();
                            message.success("测试组已删除");
                          } catch (error) {
                            message.error((error as Error).message);
                            throw error;
                          }
                        },
                      })
                    }
                  >
                    删除
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    disabled={!canEdit || busy || !row.flow_ids?.length}
                    onClick={() =>
                      void perform(async () => {
                        const result = await api(
                          `/projects/${pid}/suites/${row.id}/runs`,
                          "POST",
                        );
                        await cache.invalidateQueries({
                          queryKey: ["suite-runs", pid, eid],
                        });
                        onOpenRun(result.id);
                      })
                    }
                  >
                    运行测试组
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </div>
      <div className="table-card" style={{ marginTop: 20 }}>
        <Typography.Title level={4}>测试组运行记录</Typography.Title>
        <Failure error={history.error} retry={() => void history.refetch()} />
        <Table
          rowKey="id"
          loading={history.isFetching}
          dataSource={history.data?.items || []}
          scroll={{ x: 800 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: false,
            showTotal: (n) => `共 ${n} 条`,
          }}
          columns={[
            { title: "测试组", dataIndex: "suite_name" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <Status value={value} />,
            },
            {
              title: "结果",
              render: (_: any, row: any) =>
                `${row.passed_count || 0} 通过 / ${row.failed_count || 0} 失败 / ${row.total_count || 0} 总计`,
            },
            { title: "创建时间", dataIndex: "created_at", render: date },
            {
              title: "操作",
              render: (_: any, row: any) => (
                <Button type="link" onClick={() => onOpenRun(row.id)}>
                  查看报告
                </Button>
              ),
            },
          ]}
        />
      </div>
      {editor && (
        <SuiteEditor
          pid={pid}
          eid={eid}
          suite={editor}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
            message.success("测试组已保存");
          }}
        />
      )}
    </>
  );
}

function SuiteEditor({
  pid,
  eid,
  suite,
  onClose,
  onSaved,
}: {
  pid: string;
  eid: string;
  suite: any;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [known, setKnown] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (suite.flows || []).map((flow: any) => [flow.id, flow.name]),
    ),
  );
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const flows = useQuery({
    queryKey: ["suite-flow-options", pid, eid, debounced],
    queryFn: ({ signal }) =>
      api(
        `/projects/${pid}/resources/flows?pageSize=50&environmentId=${eid}&q=${encodeURIComponent(debounced)}`,
        "GET",
        undefined,
        signal,
      ),
  });
  const options = (flows.data?.items || []).map((flow: any) => ({
    value: flow.id,
    label: `${flow.name} · ${flowCategories.find((category) => category.value === flow.category)?.label || "功能检查"}`,
  }));
  const save = useMutation({
    mutationFn: (values: any) =>
      api(
        `/projects/${pid}/suites${suite.id ? "/" + suite.id : ""}`,
        suite.id ? "PUT" : "POST",
        {
          ...(suite.id ? {} : { environmentId: eid }),
          name: values.name,
          description: values.description || "",
          flowIds: values.flowIds,
        },
      ),
    onSuccess: onSaved,
  });
  return (
    <Modal
      open
      title={suite.id ? "编辑测试组" : "创建测试组"}
      width={760}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Failure error={save.error} />
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: suite.name,
          description: suite.description,
          flowIds: suite.flow_ids || [],
        }}
        onFinish={(values) => save.mutate(values)}
        scrollToFirstError
      >
        <Form.Item
          name="name"
          label="测试组名称"
          rules={[
            { required: true, message: "请输入测试组名称" },
            { max: 120 },
          ]}
        >
          <Input autoFocus placeholder="例如：核心功能回归" />
        </Form.Item>
        <Form.Item name="description" label="描述" rules={[{ max: 4000 }]}>
          <Input.TextArea rows={2} placeholder="说明这个测试组覆盖的范围" />
        </Form.Item>
        <Typography.Title level={5}>按执行顺序选择流程</Typography.Title>
        <Form.List
          name="flowIds"
          rules={[
            {
              validator: async (_, values) => {
                if (!values?.length) throw new Error("请至少添加一个流程");
                if (values.some((value: string) => !value))
                  throw new Error("请选择每一项流程");
              },
            },
          ]}
        >
          {(fields, { add, remove, move }, { errors }) => (
            <>
              {fields.map((field, index) => {
                const current = form.getFieldValue(["flowIds", field.name]);
                const choices =
                  current &&
                  !options.some((option: any) => option.value === current)
                    ? [
                        {
                          value: current,
                          label:
                            known[current] || `已选流程 ${current.slice(0, 8)}`,
                        },
                        ...options,
                      ]
                    : options;
                return (
                  <div key={field.key} className="suite-flow-row">
                    <Tag> {index + 1} </Tag>
                    <Form.Item
                      name={field.name}
                      rules={[{ required: true, message: "请选择流程" }]}
                      style={{
                        flex: "1 1 180px",
                        minWidth: 0,
                        marginBottom: 0,
                      }}
                    >
                      <Select
                        aria-label={`流程 ${index + 1}`}
                        showSearch
                        filterOption={false}
                        onSearch={setSearch}
                        loading={flows.isFetching}
                        options={choices}
                        placeholder="搜索并选择流程"
                        onChange={(value) => {
                          const flow = flows.data?.items.find(
                            (item: any) => item.id === value,
                          );
                          if (flow)
                            setKnown((old) => ({ ...old, [value]: flow.name }));
                        }}
                        notFoundContent={
                          flows.error ? "加载失败，请重试搜索" : undefined
                        }
                      />
                    </Form.Item>
                    <Button
                      aria-label="上移流程"
                      icon={<ArrowUp size={14} />}
                      disabled={!index}
                      onClick={() => move(index, index - 1)}
                    />
                    <Button
                      aria-label="下移流程"
                      icon={<ArrowDown size={14} />}
                      disabled={index === fields.length - 1}
                      onClick={() => move(index, index + 1)}
                    />
                    <Button
                      aria-label="移除流程"
                      icon={<Trash2 size={14} />}
                      onClick={() => remove(index)}
                    />
                  </div>
                );
              })}
              <Button
                type="dashed"
                icon={<Plus size={14} />}
                onClick={() => add()}
              >
                添加流程
              </Button>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
