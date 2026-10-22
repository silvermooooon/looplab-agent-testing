import { useEffect, useState } from "react";
export function DemoTarget() {
  const [authed, setAuthed] = useState(false),
    [error, setError] = useState(""),
    [reply, setReply] = useState(""),
    [sending, setSending] = useState(false);
  useEffect(() => {
    fetch("/demo/api/me")
      .then((r) => r.json())
      .then((d) => setAuthed(d.authenticated));
  }, []);
  return (
    <main className="demo-shell">
      <div className="eyebrow">LOOPLAB / DEMO TARGET</div>
      <h1>Agent 对话平台</h1>
      <p className="muted">用于端到端验收的独立示例应用</p>
      {!authed ? (
        <form
          className="demo-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const r = await fetch("/demo/api/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                username: data.get("username"),
                password: data.get("password"),
              }),
            });
            if (r.ok) setAuthed(true);
            else setError("用户名或密码错误");
          }}
        >
          <h2>登录工作空间</h2>
          <label>
            邮箱
            <input id="username" name="username" type="email" required />
          </label>
          <label>
            密码
            <input id="password" name="password" type="password" required />
          </label>
          <button id="login-button" type="submit">
            登录
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <div className="demo-card">
          <h2 data-testid="welcome">欢迎进入对话平台</h2>
          <div
            className="chat-response"
            data-testid="assistant-reply"
            aria-live="polite"
          >
            {reply || "发送一条消息开始测试。"}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const message = String(
                new FormData(e.currentTarget).get("message"),
              );
              setSending(true);
              const r = await fetch("/demo/api/message", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message }),
              });
              setReply((await r.json()).reply);
              setSending(false);
            }}
          >
            <label>
              消息
              <textarea
                id="message-input"
                name="message"
                placeholder="输入消息"
                required
              />
            </label>
            <button id="send-message" disabled={sending}>
              发送消息
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
