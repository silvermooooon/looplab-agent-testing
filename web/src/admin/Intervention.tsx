import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Input, Space, Typography } from "antd";
import { api } from "./client";
import InterventionKeyboard, {
  type KeyboardStep,
} from "./InterventionKeyboard";

type Intervention = {
  active: boolean;
  info: {
    message: string;
    trigger: string;
    dialog?: { type: string; message: string; defaultValue: string };
  } | null;
};

type Action = Record<string, string | number>;
type PendingAction =
  { step: KeyboardStep } | { body: Action; resolve: (ok: boolean) => void };

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
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [text, setText] = useState("");
  const [key, setKey] = useState("Escape");
  const [dialogText, setDialogText] = useState(info.dialog?.defaultValue || "");
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const queue = useRef<PendingAction[]>([]);
  const sending = useRef(false);
  const mounted = useRef(false);
  const refreshScreenshot = useRef<() => void>(() => {});

  function clearQueue() {
    for (const pending of queue.current.splice(0)) {
      if ("resolve" in pending) pending.resolve(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearQueue();
    };
  }, []);

  useEffect(() => {
    setDialogText(info.dialog?.defaultValue || "");
  }, [info.dialog?.defaultValue, info.dialog?.message, info.dialog?.type]);

  useEffect(() => {
    let stopped = false;
    let capturing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (stopped || capturing) return;
      clearTimeout(timer);
      capturing = true;
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
            setImage(next);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = next;
          }
        }
      } catch {
        // The run may finish while a screenshot is being fetched.
      } finally {
        capturing = false;
        if (!stopped) timer = setTimeout(refresh, 1500);
      }
    };
    refreshScreenshot.current = () => void refresh();
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  async function send(
    body: Action | { type: "keyboard"; steps: KeyboardStep[] },
  ) {
    try {
      await api(`/runs/${id}/intervention/actions`, "POST", body);
      return true;
    } catch (error) {
      if (mounted.current) message.error((error as Error).message);
      return false;
    } finally {
      void cache.invalidateQueries({ queryKey: ["intervention", id] });
    }
  }

  async function flushQueue() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    let pending: PendingAction | undefined;
    while (mounted.current && (pending = queue.current.shift())) {
      let ok: boolean;
      if ("step" in pending) {
        const steps = [pending.step];
        while (steps.length < 32) {
          const next = queue.current[0];
          if (!next || !("step" in next)) break;
          steps.push(next.step);
          queue.current.shift();
        }
        ok = await send({ type: "keyboard", steps });
      } else {
        ok = await send(pending.body);
        pending.resolve(ok);
      }
      if (!ok) {
        clearQueue();
        break;
      }
    }
    sending.current = false;
    if (mounted.current) {
      setBusy(false);
      refreshScreenshot.current();
    }
  }

  async function action(body: Action) {
    if (body.type === "dialogAccept" || body.type === "dialogDismiss") {
      setDialogBusy(true);
      try {
        return await send(body);
      } finally {
        setDialogBusy(false);
        refreshScreenshot.current();
      }
    }
    return new Promise<boolean>((resolve) => {
      queue.current.push({ body, resolve });
      void flushQueue();
    });
  }

  const dialog = info.dialog;
  const keyboardEnabled = !!image && canEdit && !dialogBusy && !dialog;
  const keyboardHelpId = `takeover-keyboard-${id}`;
  return (
    <section className="intervention-panel" aria-label="人工接管">
      <Alert
        type="warning"
        showIcon
        title="等待人工处理"
        description={info.message || "请处理当前页面后继续运行。"}
      />
      <Typography.Paragraph type="secondary" id={keyboardHelpId}>
        {canEdit
          ? "点击画面后直接打字、粘贴或使用 Tab 和方向键。点击画面外或按 Shift+Esc 退出键盘控制。处理完毕后，确认页面状态并继续运行。"
          : "当前账号可以查看测试浏览器画面。"}
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
      {keyboardEnabled && (
        <div className="intervention-keyboard-status">
          {keyboardFocused ? "键盘已连接" : "点击画面连接键盘"}
        </div>
      )}
      <div className="intervention-viewport">
        <InterventionKeyboard
          inputRef={keyboardRef}
          enabled={keyboardEnabled}
          helpId={keyboardHelpId}
          onStep={(step) => {
            queue.current.push({ step });
            void flushQueue();
          }}
          onFocusChange={setKeyboardFocused}
          onError={(error) => void message.error(error)}
        />
        {image && !dialog ? (
          <img
            src={image}
            alt="测试浏览器实时画面，点击可操作页面"
            aria-label="接管画面"
            draggable={false}
            onClick={(event) => {
              if (!keyboardEnabled) return;
              const target = event.currentTarget;
              const rect = target.getBoundingClientRect();
              const input = keyboardRef.current;
              if (input) {
                input.style.left = `${event.clientX - rect.left}px`;
                input.style.top = `${event.clientY - rect.top}px`;
                input.focus({ preventScroll: true });
              }
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
            {dialog ? "处理浏览器弹框后恢复画面" : "正在读取浏览器画面…"}
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
