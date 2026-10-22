import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from "antd";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { api, Failure, useApi } from "./client";
const required = [{ required: true, message: "请填写此项" }];
const names: Record<string, string> = {
  environments: "环境配置",
  clone: "复制环境",
  cases: "测试用例",
  nodes: "节点版本",
  flows: "编排流程",
  knowledge: "知识文档",
  team: "项目成员",
  repair: "修复节点",
};
const pairs = (obj: any) =>
  Object.entries(obj || {}).map(([key, value]) => ({ key, value }));
function fromPairs(rows: any[] = []) {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (!row.key?.trim()) throw new Error("配置键不能为空");
    if (Object.hasOwn(result, row.key))
      throw new Error(`配置键重复：${row.key}`);
    result[row.key] = row.value || "";
  }
  return result;
}
function PairFields({
  name,
  label,
  secret = false,
}: {
  name: string;
  label: string;
  secret?: boolean;
}) {
  return (
    <>
      <Typography.Title level={5}>{label}</Typography.Title>
      <Form.List name={name}>
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <div className="pair-row" key={field.key}>
                <Form.Item name={[field.name, "key"]} rules={required}>
                  <Input
                    aria-label={`${label}键`}
                    placeholder="名称，如 username"
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, "value"]}
                  rules={secret ? required : []}
                >
                  {secret ? (
                    <Input.Password
                      aria-label={`${label}值`}
                      placeholder="新值"
                      autoComplete="new-password"
                    />
                  ) : (
                    <Input aria-label={`${label}值`} placeholder="值" />
                  )}
                </Form.Item>
                <Button
                  aria-label="删除配置项"
                  icon={<Trash2 size={15} />}
                  onClick={() => remove(field.name)}
                />
              </div>
            ))}
            <Button
              type="dashed"
              icon={<Plus size={14} />}
              onClick={() => add({ key: "", value: "" })}
            >
              添加{label}
            </Button>
          </>
        )}
      </Form.List>
    </>
  );
}
function RemoteSelect({
  pid,
  resource,
  eid,
  value,
  onChange,
  onItem,
  placeholder,
  selectedLabel,
}: {
  pid: string;
  resource: string;
  eid: string;
  value?: string;
  onChange?: (v: string) => void;
  onItem?: (v: any) => void;
  placeholder: string;
  selectedLabel?: string;
}) {
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const list = useApi(
    ["options", pid, resource, eid, debounced],
    `/projects/${pid}/resources/${resource}?pageSize=50&q=${encodeURIComponent(debounced)}${eid ? "&environmentId=" + eid : ""}`,
  );
  const rows = list.data?.items || [],
    opts = rows.map((x: any) => ({
      value: resource === "nodes" ? x.revision_id : x.id,
      label: resource === "nodes" ? `${x.name} · v${x.version}` : x.title,
    }));
  if (value && !opts.some((o: any) => o.value === value))
    opts.unshift({
      value,
      label: selectedLabel || "已选版本 " + value.slice(0, 8),
    });
  return (
    <Select
      aria-label={placeholder}
      showSearch
      filterOption={false}
      onSearch={setSearch}
      loading={list.isFetching}
      placeholder={placeholder}
      value={value}
      options={opts}
      onChange={(v) => {
        onChange?.(v);
        onItem?.(
          rows.find(
            (x: any) => (resource === "nodes" ? x.revision_id : x.id) === v,
          ),
        );
      }}
      notFoundContent={list.error ? "加载失败，请重试搜索" : undefined}
    />
  );
}
export default function ResourceEditor({
  editor,
  pid,
  eid,
  canEdit,
  onClose,
  onSaved,
}: {
  editor: any;
  pid: string;
  eid: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (result?: any) => Promise<void>;
}) {
  const { kind, item } = editor;
  const [form] = Form.useForm();
  const [catalog, setCatalog] = useState<Record<string, any>>({});
  const initial = {
    ...item,
    baseUrl: item?.base_url,
    name:
      kind === "clone"
        ? `${item?.name} · 副本`
        : kind === "flows" && item
          ? `${item.name} · 新版本`
          : item?.name,
    variables: pairs(item?.variables),
    secretUpdates: [],
    removeSecrets: [],
    copySecrets: false,
    caseId: item?.case_id,
    role: item?.role || "editor",
    steps: item?.steps || [],
    spec: JSON.stringify(
      item?.spec || {
        inputs: ["message"],
        steps: [
          {
            action: "fill",
            selector: "#message-input",
            value: "{{param.message}}",
          },
          { action: "click", selector: "#send-message" },
        ],
      },
      null,
      2,
    ),
  };
  const save = useMutation({
    mutationFn: async (v: any) => {
      if (kind === "environments") {
        const secretSet = fromPairs(v.secretUpdates),
          body = {
            name: v.name,
            baseUrl: v.baseUrl,
            variables: fromPairs(v.variables),
            ...(item
              ? {
                  secretChanges: {
                    set: secretSet,
                    remove: v.removeSecrets || [],
                  },
                }
              : { secrets: secretSet }),
          };
        const r = await api(
          `/projects/${pid}/environments${item ? "/" + item.id : ""}`,
          item ? "PUT" : "POST",
          body,
        );
        return { environmentId: item?.id || r.id };
      }
      if (kind === "clone") {
        const r = await api(
          `/projects/${pid}/environments/${item.id}/clone`,
          "POST",
          { name: v.name, baseUrl: v.baseUrl, copySecrets: !!v.copySecrets },
        );
        return { environmentId: r.id };
      }
      if (kind === "cases" || kind === "knowledge")
        return api(
          `/projects/${pid}/${kind}${item ? "/" + item.id : ""}`,
          item ? "PUT" : "POST",
          kind === "cases"
            ? { title: v.title, instructions: v.instructions }
            : { title: v.title, content: v.content },
        );
      if (kind === "nodes")
        return api(`/projects/${pid}/nodes`, "POST", {
          environmentId: eid,
          key: v.key,
          name: v.name,
          description: v.description || "",
          spec: JSON.parse(v.spec),
        });
      if (kind === "flows")
        return api(`/projects/${pid}/flows`, "POST", {
          environmentId: eid,
          caseId: v.caseId,
          name: v.name,
          steps: (v.steps || []).map((s: any) => ({
            revisionId: s.revisionId,
            params: s.params || {},
          })),
        });
      if (kind === "team")
        return api(`/projects/${pid}/members`, "POST", {
          email: v.email,
          role: v.role,
        });
      if (kind === "repair") {
        const r = await api(`/projects/${pid}/runs`, "POST", {
          environmentId: eid,
          caseId: v.caseId,
          mode: "repair",
          repairNodeId: item.node_id,
        });
        return { runId: r.id };
      }
    },
    onSuccess: onSaved,
  });
  return (
    <Modal
      open
      title={`${item && kind !== "clone" ? "编辑" : "新建"}${names[kind]}`}
      width={kind === "flows" || kind === "nodes" ? 820 : 660}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={kind === "repair" ? "开始修复" : "保存"}
      cancelText="取消"
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !canEdit }}
      destroyOnHidden
    >
      <Failure error={save.error} />
      <Form
        form={form}
        layout="vertical"
        initialValues={initial}
        onFinish={(v) => save.mutate(v)}
        disabled={!canEdit}
        scrollToFirstError
      >
        {["environments", "clone", "nodes", "flows"].includes(kind) && (
          <Form.Item
            name="name"
            label={
              kind === "environments" || kind === "clone" ? "环境名称" : "名称"
            }
            rules={[...required, { max: 120 }]}
          >
            <Input
              autoFocus
              placeholder={
                kind === "environments" ? "例如：开发环境" : undefined
              }
            />
          </Form.Item>
        )}
        {["environments", "clone"].includes(kind) && (
          <Form.Item
            name="baseUrl"
            label="部署地址"
            rules={[
              ...required,
              {
                validator: async (_, value) => {
                  try {
                    const u = new URL(value);
                    if (
                      !["http:", "https:"].includes(u.protocol) ||
                      u.username ||
                      u.password
                    )
                      throw 0;
                  } catch {
                    throw new Error(
                      "请输入有效 HTTP/HTTPS 地址，凭据请单独填写",
                    );
                  }
                },
              },
            ]}
          >
            <Input placeholder="https://staging.example.com" />
          </Form.Item>
        )}
        {kind === "environments" && (
          <>
            <PairFields name="variables" label="变量" />
            <Alert
              style={{ marginTop: 20 }}
              type="info"
              showIcon
              title="凭据加密保存在服务端。留空保留已有值；输入同名键可替换，删除需明确勾选。"
            />
            {!!item?.secretKeys.length && (
              <Form.Item name="removeSecrets" label="删除已有凭据">
                <Checkbox.Group options={item.secretKeys} />
              </Form.Item>
            )}
            <PairFields name="secretUpdates" label="凭据" secret />
          </>
        )}
        {kind === "clone" && (
          <>
            <Alert
              type="info"
              title="复制变量、全部节点版本与流程，并重新绑定到新环境。后续修改互不影响。"
            />
            <Form.Item name="copySecrets" valuePropName="checked">
              <Checkbox>同时复制加密凭据</Checkbox>
            </Form.Item>
          </>
        )}
        {["cases", "knowledge"].includes(kind) && (
          <Form.Item
            label="标题"
            name="title"
            rules={[...required, { max: 120 }]}
          >
            <Input autoFocus />
          </Form.Item>
        )}
        {kind === "cases" && (
          <Form.Item
            label="测试步骤和预期结果"
            name="instructions"
            rules={[...required, { max: 20000 }]}
          >
            <Input.TextArea
              rows={8}
              placeholder="例如：登录对话平台，发送一条消息，确认回复可见且无错误。"
            />
          </Form.Item>
        )}
        {kind === "knowledge" && (
          <>
            <Form.Item
              name="content"
              label="知识内容"
              rules={[...required, { max: 60000 }]}
            >
              <Input.TextArea rows={12} />
            </Form.Item>
            <Upload
              accept=".txt,.md"
              showUploadList={false}
              beforeUpload={async (file) => {
                if (file.size > 200000) {
                  form.setFields([
                    { name: "content", errors: ["文件不能超过 200 KB"] },
                  ]);
                  return false;
                }
                form.setFieldValue("content", await file.text());
                return false;
              }}
            >
              <Button>导入 Markdown / 文本</Button>
            </Upload>
          </>
        )}
        {kind === "nodes" && (
          <>
            <Form.Item
              name="key"
              label="唯一标识"
              rules={[
                ...required,
                {
                  pattern: /^[a-z][a-z0-9_-]{1,63}$/,
                  message:
                    "使用 2–64 位小写字母、数字、下划线或短横线，以字母开头",
                },
              ]}
            >
              <Input disabled={!!item} placeholder="send_message" />
            </Form.Item>
            <Form.Item name="description" label="用途说明">
              <Input />
            </Form.Item>
            <Alert
              type="info"
              title="保存为新版本，既有流程仍引用原版本。支持 {{param.message}}、{{secret.password}} 等变量。"
            />
            <Form.Item
              name="spec"
              label="步骤定义（JSON）"
              rules={[
                ...required,
                {
                  validator: async (_, v) => {
                    try {
                      JSON.parse(v);
                    } catch {
                      throw new Error("JSON 格式不正确");
                    }
                  },
                },
              ]}
            >
              <Input.TextArea rows={14} style={{ fontFamily: "monospace" }} />
            </Form.Item>
          </>
        )}
        {["flows", "repair"].includes(kind) && (
          <Form.Item name="caseId" label="测试用例" rules={required}>
            <RemoteSelect
              pid={pid}
              eid={eid}
              resource="cases"
              placeholder="搜索并选择测试用例"
              selectedLabel={item?.case_title}
            />
          </Form.Item>
        )}
        {kind === "repair" && (
          <Alert
            type="info"
            title={`修复「${item.name}」在当前环境的节点，新版本会保留原有断言，再通过浏览器重放验证。`}
          />
        )}
        {kind === "flows" && (
          <>
            <Alert
              type="info"
              title="保存为独立流程，节点版本与参数固定。编辑副本不会改变已保存的流程。"
            />
            <Form.List
              name="steps"
              rules={[
                {
                  validator: async (_, v) => {
                    if (!v?.length) throw new Error("至少添加一个节点");
                  },
                },
              ]}
            >
              {(fields, { add, remove, move }, { errors }) => (
                <>
                  {fields.map((field, index) => (
                    <div className="table-card step-card" key={field.key}>
                      <Space style={{ marginBottom: 12 }}>
                        <Tag>步骤 {index + 1}</Tag>
                        <Button
                          aria-label="上移节点"
                          disabled={!index}
                          icon={<ArrowUp size={14} />}
                          onClick={() => move(index, index - 1)}
                        />
                        <Button
                          aria-label="下移节点"
                          disabled={index === fields.length - 1}
                          icon={<ArrowDown size={14} />}
                          onClick={() => move(index, index + 1)}
                        />
                        <Button
                          aria-label="移除节点"
                          icon={<Trash2 size={14} />}
                          onClick={() => remove(index)}
                        />
                      </Space>
                      <Form.Item
                        name={[field.name, "revisionId"]}
                        label="复用节点"
                        rules={required}
                      >
                        <RemoteSelect
                          pid={pid}
                          eid={eid}
                          resource="nodes"
                          placeholder="搜索并选择节点"
                          onItem={(node) => {
                            if (node) {
                              setCatalog((old) => ({
                                ...old,
                                [node.revision_id]: node,
                              }));
                              form.setFieldValue(
                                ["steps", field.name, "params"],
                                Object.fromEntries(
                                  node.spec.inputs.map((k: string) => [k, ""]),
                                ),
                              );
                            }
                          }}
                        />
                      </Form.Item>
                      <Form.Item noStyle shouldUpdate>
                        {() => {
                          const step = form.getFieldValue([
                            "steps",
                            field.name,
                          ]);
                          const inputs =
                            catalog[step?.revisionId]?.spec.inputs ||
                            Object.keys(step?.params || {});
                          return inputs.map((key: string) => (
                            <Form.Item
                              key={key}
                              label={`参数 · ${key}`}
                              name={[field.name, "params", key]}
                              rules={required}
                            >
                              <Input />
                            </Form.Item>
                          ));
                        }}
                      </Form.Item>
                    </div>
                  ))}
                  <Button
                    type="dashed"
                    block
                    icon={<Plus size={15} />}
                    onClick={() => add({ params: {} })}
                  >
                    添加节点
                  </Button>
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>
          </>
        )}
        {kind === "team" && (
          <>
            <Form.Item
              name="email"
              label="成员邮箱"
              extra="该成员需要先注册 LoopLab 账户。"
              rules={[...required, { type: "email" }]}
            >
              <Input disabled={!!item} />
            </Form.Item>
            <Form.Item name="role" label="项目权限" rules={required}>
              <Select
                options={[
                  { value: "editor", label: "编辑者 · 创建、修改和执行测试" },
                  { value: "viewer", label: "只读成员 · 查看资产和报告" },
                ]}
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
