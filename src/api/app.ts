import { Hono } from "hono";
import { createWorkflowsApp } from "./workflows.js";
import { createTasksApp } from "./tasks.js";
import { TaskRegistry } from "../tasks/registry.js";
import { ensureStorageDirs } from "../storage/file-store.js";

/**
 * 构造完整的 Hono 应用（挂载 /api/workflows 与 /api/tasks）。
 * 测试/可组合入口：调用方可传入自定义 registry（如指向临时 data 目录）。
 */
export function createApp(registry?: TaskRegistry): Hono {
  ensureStorageDirs();
  const reg = registry ?? new TaskRegistry();
  const app = new Hono();
  app.route("/api/workflows", createWorkflowsApp(reg));
  app.route("/api/tasks", createTasksApp(reg));
  app.get("/health", (c) => c.json({ status: "success", data: { ok: true } }));
  return app;
}
