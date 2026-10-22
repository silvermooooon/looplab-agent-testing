import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { routes } from "./routes.js";

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie, { secret: config.appSecret });
  await app.register(rateLimit, { max: 1500, timeWindow: "1 minute" });
  app.addHook("onSend", async (_r, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin");
  });
  app.setErrorHandler((error: any, _r, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
    if (error.code === "23505")
      return reply
        .code(409)
        .send({ error: "名称或邮箱已存在，请使用其他名称" });
    if (error.statusCode)
      return reply.code(error.statusCode).send({ error: error.message });
    console.error("Request failed:", error.code ?? error.name ?? "unknown");
    return reply.code(500).send({ error: "服务处理失败，请检查服务器日志" });
  });
  await routes(app);
  if (config.demoEnabled) {
    app.post("/demo/api/login", async (r, reply) => {
      const body = z
        .object({ username: z.string(), password: z.string() })
        .parse(r.body);
      if (
        body.username !== "tester@example.com" ||
        body.password !== "Demo-Password-2026!"
      )
        return reply.code(401).send({ error: "Invalid demo credentials" });
      reply.setCookie("demo_session", "authenticated", {
        signed: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/demo",
      });
      return { ok: true };
    });
    app.get("/demo/api/me", async (r) => ({
      authenticated:
        r.unsignCookie(r.cookies.demo_session ?? "").value === "authenticated",
    }));
    app.post("/demo/api/message", async (r, reply) => {
      if (
        r.unsignCookie(r.cookies.demo_session ?? "").value !== "authenticated"
      )
        return reply.code(401).send({ error: "Login required" });
      const { message } = z
        .object({ message: z.string().min(1).max(2000) })
        .parse(r.body);
      return { reply: `Echo: ${message} · 系统状态：正常` };
    });
  }
  const webRoot = resolve("web-dist");
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler(async (r, reply) => {
      if (
        r.url.startsWith("/api/") ||
        r.url.startsWith("/demo/api/") ||
        (r.url.startsWith("/demo") && !config.demoEnabled)
      )
        return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
