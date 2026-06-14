import { Hono } from "hono";
import { createWorkflowsApp } from "./workflows.js";
import { createTasksApp } from "./tasks.js";
import { TaskRegistry, type TaskRuntime } from "../tasks/registry.js";
import { ensureStorageDirs } from "../storage/file-store.js";
import { createDefaultToolRegistry } from "../executor/default-tools.js";
import {
  registerBuiltinTools,
  registerHeavyIoTools,
  createTavilyProvider,
} from "../tools/index.js";
import { SubprocessAdapter } from "../tools/heavy-io/subprocess-adapter.js";
import type { HeavyIoConfig } from "../tools/heavy-io/provider.js";
import { LlmService } from "../services/llm-service.js";
import { getArtifactsDir } from "../core/config.js";

/**
 * 构造完整的 Hono 应用（挂载 /api/workflows 与 /api/tasks）。
 * 测试/可组合入口：调用方可传入自定义 registry（如指向临时 data 目录）。
 *
 * 默认装配真实 runtime（planner + executor + 内置工具 + 重 IO domain 工具）：
 *   - 设置 OPENAI_API_KEY 时启用 LlmService；否则 planner 回退启发式抽取。
 *   - 设置 LIF_AICF_REPO_ROOT 时注册 podcast 完整链 domain 工具（TTS/生图/视频）。
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

/** 默认 registry：注册内置工具 + 重 IO domain 工具 + LlmService。 */
export function createDefaultRegistry(): TaskRegistry {
  const toolRegistry = createDefaultToolRegistry();
  const llm = new LlmService({ apiKey: process.env.OPENAI_API_KEY });
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: process.env.TAVILY_API_KEY ? createTavilyProvider(process.env.TAVILY_API_KEY) : undefined,
  });

  // 重 IO domain 工具：需配置 ai-content-factory 仓库根 + Python 解释器
  const heavyConfig = buildHeavyIoConfig();
  if (heavyConfig) {
    const adapter = new SubprocessAdapter(heavyConfig);
    registerHeavyIoTools(toolRegistry, { adapter, llm, config: heavyConfig });
  }

  const runtime: TaskRuntime = { llm, toolRegistry };
  return new TaskRegistry(undefined, runtime);
}

/**
 * 从环境变量构建 HeavyIoConfig；未配置仓库根时返回 null（跳过 domain 工具注册）。
 *   LIF_AICF_REPO_ROOT   ai-content-factory 仓库根（必填）
 *   LIF_PYTHON_BIN       通用 Python（缺省 python3）
 *   LIF_TTS_PYTHON_BIN   Qwen3-TTS venv python（缺省同 LIF_PYTHON_BIN）
 *   LIF_REWRITE_BACKEND  ollama | openai（缺省 ollama）
 *   LIF_OLLAMA_MODEL     rewrite 用的 ollama 模型
 */
function buildHeavyIoConfig(): HeavyIoConfig | null {
  const repoRoot = process.env.LIF_AICF_REPO_ROOT;
  if (!repoRoot) return null;
  return {
    repoRoot,
    pythonBin: process.env.LIF_PYTHON_BIN ?? "python3",
    ttsPythonBin: process.env.LIF_TTS_PYTHON_BIN ?? process.env.LIF_PYTHON_BIN ?? "python3",
    artifactsDir: getArtifactsDir(),
    rewriteBackend: (process.env.LIF_REWRITE_BACKEND as "ollama" | "openai") ?? "ollama",
    ollamaRewriteModel: process.env.LIF_OLLAMA_MODEL,
  };
}
