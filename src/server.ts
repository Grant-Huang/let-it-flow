import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { RUNTIME } from "./core/config.js";

/**
 * HTTP 服务器入口。
 *
 * `pnpm dev` 运行本文件（tsx watch src/server.ts），把 createApp() 产出的
 * Hono 应用绑定到 RUNTIME.port（默认 8787）。
 *
 * 注意：src/index.ts 是 SDK 的导出入口（进程内调用），不含 HTTP 启动逻辑；
 * HTTP 形态由本文件提供（见 docs/02 §2.6 SDK/HTTP 双形态）。
 */
const app = createApp();
const port = RUNTIME.port;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[let-it-flow] HTTP server on http://localhost:${info.port}`);
  console.log(`[let-it-flow] data dir: ${process.env.LIF_DATA_DIR ?? "./data"}`);
  console.log(`[let-it-flow] endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  POST /api/workflows`);
  console.log(`  GET  /api/tasks`);
  console.log(`  GET  /api/tasks/:id`);
  console.log(`  GET  /api/tasks/:id/stream (SSE)`);
  console.log(`  GET/POST/PUT/DELETE /api/config/models`);
  console.log(`  GET/PUT            /api/config/bindings`);
  console.log(`  GET/PUT            /api/config/system`);
  console.log(`  GET/PUT            /api/config/heavy-io`);
});
