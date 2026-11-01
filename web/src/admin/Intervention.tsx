import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Input, Space, Typography } from "antd";
import { api } from "./client";

type Intervention = {
  active: boolean;
  info: {
    message: string;
    trigger: string;
    dialog?: { type: string; message: string; defaultValue: string };
  } | null;
};

export function useIntervention(id: string | undefined, running: boolean) {
  return useQuery<Intervention>({
    queryKey: ["intervention", id],
    queryFn: ({ signal }) =>
      api(`/runs/${id}/intervention`, "GET", undefined, signal),
    enabled: !!id && running,
    refetchInterval: running ? 1500 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export default function InterventionPanel({
  id,
  canEdit,
  info,
}: {
  id: string;
  canEdit: boolean;
  info: NonNullable<Intervention["info"]>;
}) {
  const cache = useQueryClient();
  const { message } = App.useApp();
  const [image, setImage] = useState<string>();
  const [screenshotBlocked, setScreenshotBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [text, setText] = useState("");
  const [key, setKey] = useState("Escape");
  const [dialogText, setDialogText] = useState(info.dialog?.defaultValue || "");
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setDialogText(info.dialog?.defaultValue || "");
  }, [info.dialog?.defaultValue, info.dialog?.message, info.dialog?.type]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/runs/${id}/intervention/screenshot`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (response.ok) {
          const blob = await response.blob();
          if (!stopped) {
            const next = URL.createObjectURL(blob);
            setScreenshotBlocked(false);
            setImage(next);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = next;
          }
        } else if (response.status === 409 && !stopped) {
          setScreenshotBlocked(true);
        }
      } catch {
        // The run may finish while a screenshot is being fetched.
      } finally {
        if (!stopped) timer = setTimeout(refresh, 1500);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  async function action(body: Record<string, string | number>) {
    const setPending =
      body.type === "dialogAccept" || body.type === "dialogDismiss"
        ? setDialogBusy
        : setBusy;
    setPending(true);
    try {
      await api(`/runs/${id}/intervention/actions`, "POST", body);
      await cache.invalidateQueries({ queryKey: ["intervention", id] });
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }

  const dialog = info.dialog;
  return (
    <section className="intervention-panel" aria-label="人工接管">
      <Alert
        type="warning"
        showIcon
        title="等待人工处理"
        description={info.message || "请处理当前页面后继续运行。"}
      />
      <Typography.Paragraph type="secondary">
        这是测试正在使用的浏览器。点击画面选择元素，再使用下方控件输入文字或按键；处理完成后继续运行。
        触发时已开始的浏览器操作可能继续完成；处理后请检查页面状态，再继续运行。
        {!canEdit && " 当前账号为只读，不能操作浏览器。"}
      </Typography.Paragraph>
      {dialog && (
        <div className="intervention-dialog" role="alert">
          <Typography.Text strong>浏览器弹框 · {dialog.type}</Typography.Text>
          <Typography.Paragraph>{dialog.message}</Typography.Paragraph>
          {dialog.type === "prompt" && (
            <Input
              aria-label="浏览器弹框回复"
              value={dialogText}
              onChange={(event) => setDialogText(event.target.value)}
              disabled={!canEdit || dialogBusy}
            />
          )}
          <Space wrap>
            <Button
              type="primary"
              disabled={!canEdit || dialogBusy}
              onClick={() =>
                void action({ type: "dialogAccept", text: dialogText })
              }
            >
              确认弹框
            </Button>
            {dialog.type !== "alert" && (
              <Button
                disabled={!canEdit || dialogBusy}
                onClick={() => void action({ type: "dialogDismiss" })}
              >
                取消弹框
              </Button>
            )}
          </Space>
        </div>
      )}
      <div className="intervention-viewport">
        {image && !screenshotBlocked ? (
          <img
            ref={imageRef}
            src={image}
            alt="测试浏览器实时画面，点击可操作页面"
            aria-label="接管画面"
            onClick={(event) => {
              if (!canEdit || busy || dialogBusy || dialog) return;
              const target = imageRef.current!;
              const rect = target.getBoundingClientRect();
              const x = Math.min(
                target.naturalWidth - 1,
                Math.max(
                  0,
                  Math.round(
                    ((event.clientX - rect.left) * target.naturalWidth) /
                      rect.width,
                  ),
                ),
              );
              const y = Math.min(
                target.naturalHeight - 1,
                Math.max(
                  0,
                  Math.round(
                    ((event.clientY - rect.top) * target.naturalHeight) /
                      rect.height,
                  ),
                ),
              );
              void action({ type: "click", x, y });
            }}
          />
        ) : (
          <div className="intervention-placeholder">
            {dialog || screenshotBlocked
              ? "处理浏览器弹框后恢复画面"
              : "正在读取浏览器画面…"}
          </div>
        )}
      </div>
      <Space wrap className="intervention-controls">
        <Input
          aria-label="接管输入"
          placeholder="输入到当前焦点的文字"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPressEnter={() => {
            if (text && canEdit && !busy && !dialogBusy && !dialog)
              void action({ type: "type", text }).then(
                (ok) => ok && setText(""),
              );
          }}
          disabled={!canEdit || busy || dialogBusy || !!dialog}
          style={{ width: 240, maxWidth: "100%" }}
        />
        <Button
          aria-label="发送文本"
          disabled={!canEdit || busy || dialogBusy || !!dialog || !text}
          onClick={() =>
            void action({ type: "type", text }).then((ok) => ok && setText(""))
          }
        >
          输入文字
        </Button>
        <Input
          aria-label="按键"
          placeholder="例如 Escape、Enter、Tab"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onPressEnter={() => {
            if (key && canEdit && !busy && !dialogBusy && !dialog)
              void action({ type: "press", key });
          }}
          disabled={!canEdit || busy || dialogBusy || !!dialog}
          style={{ width: 160, maxWidth: "100%" }}
        />
        <Button
          aria-label="发送按键"
          disabled={!canEdit || busy || dialogBusy || !!dialog || !key}
          onClick={() => void action({ type: "press", key })}
        >
          发送按键
        </Button>
        <Button
          disabled={!canEdit || busy || dialogBusy || !!dialog}
          onClick={() => void action({ type: "scroll", deltaY: -500 })}
        >
          向上滚动
        </Button>
        <Button
          disabled={!canEdit || busy || dialogBusy || !!dialog}
          onClick={() => void action({ type: "scroll", deltaY: 500 })}
        >
          向下滚动
        </Button>
      </Space>
      <div className="intervention-resume">
        <Button
          aria-label="继续运行"
          type="primary"
          disabled={!canEdit || busy || dialogBusy || !!dialog}
          onClick={() => void action({ type: "resume" })}
        >
          处理完成，继续运行
        </Button>
      </div>
    </section>
  );
}
