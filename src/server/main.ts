import { config, validateConfig } from "./config.js";
import { migrate, pool } from "./db.js";
import { buildApp } from "./app.js";
import { startWorker, stopWorker } from "./worker.js";
validateConfig();
try {
  await migrate();
} catch (error) {
  const detail = error instanceof Error ? error.message : "未知错误";
  throw new Error(
    `数据库初始化失败，请检查 DATABASE_URL、数据库连接及迁移权限：${detail}`,
  );
}
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
startWorker();
console.log(`Agent Test Platform ready: http://${config.host}:${config.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stopWorker();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
