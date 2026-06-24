import { Hono } from "hono";
import { createWorkflowsApp } from "./workflows.js";
import { createTasksApp } from "./tasks.js";
import { createToolsApp } from "./tools.js";
import { createConversationsApp } from "./conversations.js";
import { createConfigModelsApp } from "./config-models.js";
import { createConfigBindingsApp } from "./config-bindings.js";
import { createConfigSystemApp } from "./config-system.js";
import { createConfigHeavyIoApp } from "./config-heavy-io.js";
import { TaskRegistry, type TaskRuntime } from "../tasks/registry.js";
import { ensureStorageDirs } from "../storage/file-store.js";
import { createDefaultToolRegistry } from "../executor/default-tools.js";
import {
  registerBuiltinTools,
  createTavilyProvider,
} from "../tools/index.js";
import { LlmService } from "../services/llm-service.js";
import { globalEventBus } from "../core/event-bus.js";
import { getDataDir, RUNTIME } from "../core/config.js";
import { loadConfig } from "../llm/config-loader.js";
import { ensureSeedConfig } from "../llm/seed.js";

/**
 * 构造完整的 Hono 应用（挂载 /api/workflows 与 /api/tasks）。
 * 测试/可组合入口：调用方可传入自定义 registry（如指向临时 data 目录）。
 *
 * 内核默认装配真实 runtime（planner + executor + core.* 工具）：
 *   - 设置 OPENAI_API_KEY 时启用 LlmService；否则 planner 回退启发式抽取。
 *   - 业务工具（podcast domain.* 等）和业务模板由消费应用显式注册，
 *     内核 createDefaultRegistry 不再装配任何 domain 工具。
 */
export function createApp(registry?: TaskRegistry): Hono {
  ensureStorageDirs();
  // P8.5：首次启动若 registry 为空，从 .env 派生 seed 配置
  ensureSeedConfig();
  const reg = registry ?? createDefaultRegistry();
  const app = new Hono();
  app.route("/api/workflows", createWorkflowsApp(reg));
  app.route("/api/tasks", createTasksApp(reg));
  app.route("/api/tools", createToolsApp(reg));
  app.route("/api/conversations", createConversationsApp(reg));
  app.route("/api/config/models", createConfigModelsApp(getDataDir(), globalEventBus));
  app.route("/api/config/bindings", createConfigBindingsApp(getDataDir(), globalEventBus));
  app.route("/api/config/system", createConfigSystemApp(getDataDir()));
  app.route("/api/config/heavy-io", createConfigHeavyIoApp(getDataDir()));
  app.get("/health", (c) => c.json({ status: "success", data: { ok: true } }));
  return app;
}

/** 默认 registry：注册 core.* 内置工具 + LlmService（不装配任何业务 domain 工具）。 */
export function createDefaultRegistry(): TaskRegistry {
  // P8.5：注入 runtimeConfig，让 LlmService 走 registry 完整路径
  const runtimeConfig = loadConfig();
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig,
  });
  // P8.4：订阅配置变更事件，配置改动时自动清缓存
  llm.subscribeConfigChanges(globalEventBus);
  // P8.5：校验 enabled endpoint 的 apiKeyEnv 是否已设环境变量
  const missing = runtimeConfig.registry.validateEnvKeys();
  if (missing.length > 0) {
    console.warn(
      `[let-it-flow] 以下 enabled endpoint 缺少环境变量（调用时会报鉴权错）：` +
        missing.map((m) => `${m.alias} → ${m.missingEnv}`).join(", "),
    );
  }
  const toolRegistry = createDefaultToolRegistry();
  // LIF_SEARCH_PROVIDER: native=强制 DuckDuckGo / tavily=强制 Tavily / auto=有 key 用 Tavily（默认）
  const searchPref = RUNTIME.searchProvider;
  const useTavily = !!process.env.TAVILY_API_KEY &&
    (searchPref === "tavily" || searchPref === "auto");
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: useTavily
      ? createTavilyProvider(process.env.TAVILY_API_KEY!)
      : undefined,
  });

  const runtime: TaskRuntime = { llm, toolRegistry };
  return new TaskRegistry(undefined, runtime);
}
