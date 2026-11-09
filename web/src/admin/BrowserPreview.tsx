import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Tag, Tooltip, Typography } from "antd";
import { MonitorPlay } from "lucide-react";
import "./browser-preview.css";

type PreviewMeta = {
  phase: "investigation" | "replay";
  path: string;
  width: number;
  height: number;
  capturedAt: number;
  action?: { kind: string; selector?: string };
  point?: { x: number; y: number; at: number };
};
type Frame = { url: string; meta: PreviewMeta };
type State = "waiting" | "live" | "dialog" | "ended" | "retry" | "unavailable";

const actions: Record<string, string> = {
  navigate: "打开页面",
  reload: "刷新页面",
  inspect: "检查页面元素",
  click: "点击",
  fill: "填写表单",
  press: "按键",
  uploadFile: "上传文件",
  readFile: "读取文件",
  assertText: "验证文本",
  assertVisible: "验证元素可见",
  waitFor: "等待元素出现",
  waitForHidden: "等待元素隐藏",
  waitForResponse: "等待网络响应",
  screenshot: "保存截图",
  extractText: "提取文本",
  pauseForHuman: "请求人工处理",
  watchElement: "监听元素",
  watchDialog: "监听弹框",
  watchResponse: "监听网络响应",
  clearWatchers: "清除监听",
};

export function describeBrowserAction(kind: string, selector?: string) {
  const label = actions[kind] || kind;
  return selector ? `${label} · ${selector}` : label;
}

function PreviewViewport({
  id,
  running,
  open,
}: {
  id: string;
  running: boolean;
  open: boolean;
}) {
  const [frame, setFrame] = useState<Frame>();
  const [state, setState] = useState<State>("waiting");
  const imageUrl = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!open || !running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let etag: string | null = null;
    let poll = true;

    async function refresh() {
      if (document.hidden || !poll) return;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch(`/api/runs/${id}/preview`, {
          headers: etag ? { "If-None-Match": etag } : undefined,
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 304) {
          setState("live");
        } else if (response.status === 204) {
          const status = response.headers.get("X-Preview-State");
          setState(
            status === "ended" || status === "dialog" ? status : "waiting",
          );
          poll = status !== "ended";
        } else if ([401, 403, 404].includes(response.status)) {
          setState("unavailable");
          poll = false;
        } else if (response.ok) {
          const meta = JSON.parse(
            decodeURIComponent(response.headers.get("X-Preview-Meta")!),
          ) as PreviewMeta;
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          etag = response.headers.get("ETag");
          const url = URL.createObjectURL(blob);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = url;
          setFrame({ url, meta });
          setState("live");
        } else {
          setState("retry");
        }
      } catch {
        if (!controller.signal.aborted) setState("retry");
      } finally {
        if (!controller.signal.aborted && poll && !document.hidden) {
          timer = setTimeout(refresh, 600);
        }
      }
    }

    function stop() {
      clearTimeout(timer);
      request?.abort();
    }
    function visibilityChanged() {
      stop();
      void refresh();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [id, open, running]);

  const current = running ? state : "ended";
  const meta = frame?.meta;
  const message = {
    waiting: "等待浏览器画面",
    live: "实时画面",
    dialog: "原生弹框等待处理，画面暂时暂停",
    ended: "本次运行已结束",
    retry: "画面更新中断，正在重试",
    unavailable: "无法查看此运行的浏览器画面",
  }[current];

  return (
    <section className="browser-preview" aria-label="实时浏览器画面">
      <div className="browser-preview-meta">
        <div className="browser-preview-status">
          <Tag color={current === "live" ? "processing" : "default"}>
            {message}
          </Tag>
          {meta && (
            <span>
              {meta.phase === "investigation" ? "Agent 调查" : "独立重放"}
            </span>
          )}
        </div>
        <Typography.Text type="secondary">
          只读 · 人工接管入口在执行报告
        </Typography.Text>
      </div>
      {meta && (
        <div className="browser-preview-address">
          <Typography.Text ellipsis={{ tooltip: meta.path }}>
            {meta.path}
          </Typography.Text>
          <span>{new Date(meta.capturedAt).toLocaleTimeString("zh-CN")}</span>
        </div>
      )}
      <div className="browser-preview-viewport">
        {frame ? (
          <>
            <img src={frame.url} alt="实时浏览器画面" />
            {current === "live" && frame.meta.point && (
              <span
                key={frame.meta.point.at}
                aria-hidden
                data-testid="browser-preview-click"
                className="browser-preview-click"
                style={{
                  left: `${(frame.meta.point.x / frame.meta.width) * 100}%`,
                  top: `${(frame.meta.point.y / frame.meta.height) * 100}%`,
                }}
              />
            )}
          </>
        ) : (
          <div className="browser-preview-placeholder">
            {current === "waiting"
              ? "任务打开浏览器后会显示页面和操作。"
              : message}
          </div>
        )}
      </div>
      {meta?.action && (
        <div className="browser-preview-action" aria-live="polite">
          <strong>最近操作</strong>
          <Typography.Text
            ellipsis={{ tooltip: meta.action.selector }}
            className="browser-preview-action-text"
          >
            {describeBrowserAction(meta.action.kind, meta.action.selector)}
          </Typography.Text>
        </div>
      )}
    </section>
  );
}

export default function BrowserPreview({
  id,
  status,
}: {
  id?: string;
  status?: string;
}) {
  const [open, setOpen] = useState(false);
  const running = status === "queued" || status === "running";
  return (
    <>
      <Tooltip
        title={running ? "查看页面画面与最近操作" : "运行期间可查看浏览器画面"}
      >
        <Button
          icon={<MonitorPlay size={16} />}
          onClick={() => setOpen(true)}
          disabled={!id || !running}
        >
          实时浏览器
        </Button>
      </Tooltip>
      <Drawer
        title="实时浏览器"
        open={open}
        onClose={() => setOpen(false)}
        size="min(840px, 100vw)"
        destroyOnHidden
      >
        {id && (
          <PreviewViewport key={id} id={id} running={running} open={open} />
        )}
      </Drawer>
    </>
  );
}
