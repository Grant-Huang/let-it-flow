import { Hono } from "hono";
import { createWorkflowsApp } from "./workflows.js";
import { createTasksApp } from "./tasks.js";
import { TaskRegistry, type TaskRuntime } from "../tasks/registry.js";
import { ensureStorageDirs } from "../storage/file-store.js";
import { createDefaultToolRegistry } from "../executor/default-tools.js";
import { registerBuiltinTools, createTavilyProvider } from "../tools/index.js";
import { LlmService } from "../services/llm-service.js";

/**
 * 构造完整的 Hono 应用（挂载 /api/workflows 与 /api/tasks）。
 * 测试/可组合入口：调用方可传入自定义 registry（如指向临时 data 目录）。
 *
 * 默认装配真实 runtime（planner + executor + 内置工具）：
 *   - 设置 OPENAI_API_KEY 时启用 LlmService；否则用空 key（planner 内部回退启发式抽取）。
 */
export function createApp(registry?: TaskRegistry): Hono {
  ensureStorageDirs();
  const reg = registry ?? createDefaultRegistry();
  const app = new Hono();
  app.route("/api/workflows", createWorkflowsApp(reg));
  app.route("/api/tasks", createTasksApp(reg));
  app.get("/health", (c) => c.json({ status: "success", data: { ok: true } }));
  return app;
}

/** 默认 registry：注册内置工具 + LlmService（API key 缺省时 planner 回退启发式）。 */
export function createDefaultRegistry(): TaskRegistry {
  const toolRegistry = createDefaultToolRegistry();
  const llm = new LlmService({ apiKey: process.env.OPENAI_API_KEY });
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: process.env.TAVILY_API_KEY ? createTavilyProvider(process.env.TAVILY_API_KEY) : undefined,
  });
  const runtime: TaskRuntime = { llm, toolRegistry };
  return new TaskRegistry(undefined, runtime);
}
