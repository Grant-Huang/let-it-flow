import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 全局配置：数据目录与运行时参数。
 * 所有路径基于 DATA_DIR，禁止硬编码绝对路径（见 §2.7 约定10）。
 *
 * 注意：目录解析为「惰性」——每次调用 get*Dir() 时读取 LIF_DATA_DIR，
 * 以便测试在每个用例前切换临时目录（import-time 求值会导致 env 修改不生效）。
 */

/** 解析当前数据根目录（每次读取环境变量，便于测试隔离）。 */
export function getDataDir(): string {
  return resolve(process.env.LIF_DATA_DIR ?? "./data");
}

/**
 * 解析某个消费应用（App）的独立数据根目录。
 *
 * 优先级（高 → 低）：
 *   1. App 专用 env：NEXUS_DATA_DIR / AICF_DATA_DIR —— 精细控制某个 App 的数据目录
 *   2. 默认 ./data/<appId> —— 每个 App 独立隔离，避免多 App 共用同一份 tasks/config
 *
 * 注意：不读全局 LIF_DATA_DIR。LIF_DATA_DIR 仅用于内核主服务（pnpm dev），
 * 两个消费 App（nexusops / ai-content-factory）默认各自独立，避免历史会话混在一起。
 * 若要让某 App 共享全局 ./data，设对应的 App 专用 env 指向同一目录即可。
 *
 * 由各 App 的 index.ts 在启动时调用，结果传给 boot 函数的 dataDir 选项。
 */
export function resolveAppDataDir(appId: string): string {
  // 1. App 专用 env（NEXUS_DATA_DIR / AICF_DATA_DIR）
  const appEnvKey = appId === "nexusops"
    ? "NEXUS_DATA_DIR"
    : appId === "ai-content-factory"
      ? "AICF_DATA_DIR"
      : `${appId.toUpperCase().replace(/-/g, "_")}_DATA_DIR`;
  if (process.env[appEnvKey]) return resolve(process.env[appEnvKey]!);
  // 2. 缺省：./data/<appId> 独立隔离
  return resolve("./data", appId);
}

/** 任务存储根目录：data/tasks/{taskId}/... */
export function getTasksDir(): string {
  return resolve(getDataDir(), "tasks");
}

/** 产物存储根目录：data/artifacts/{taskId}/... */
export function getArtifactsDir(): string {
  return resolve(getDataDir(), "artifacts");
}

// 向后兼容的常量（基于当前 env 快照）；新代码优先用惰性 getter。
export const DATA_DIR = getDataDir();
export const TASKS_DIR = getTasksDir();
export const ARTIFACTS_DIR = getArtifactsDir();

/** 确保存储目录存在。 */
export function ensureStorageDirs(): void {
  for (const dir of [getDataDir(), getTasksDir(), getArtifactsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 运行时配置（从环境变量读取，带默认值）。 */
export const RUNTIME = {
  /** LLM 默认模型标识，如 "openai/gpt-4o" */
  defaultModel: process.env.LIF_MODEL ?? process.env.OPENAI_MODEL ?? "openai/gpt-4o",
  /** OpenAI API Key */
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  /** OpenAI 兼容 API 的 baseURL（如 DeepSeek: https://api.deepseek.com）。缺省走 OpenAI 官方。 */
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "",
  /** Tavily 搜索 API Key（web_search 用） */
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  /** 搜索 provider 选择：native=强制 DuckDuckGo / tavily=强制 Tavily / auto=有 key 用 Tavily（默认） */
  searchProvider: process.env.LIF_SEARCH_PROVIDER ?? "auto",
  /** 端口 */
  port: Number(process.env.PORT ?? 8787),
} as const;

/**
 * 日志 verbose 级别（控制 events.jsonl / llm_calls.ndjson 落盘内容）：
 *   0 = off（不写日志文件，仅走 SSE）
 *   1 = basic（工具调用元信息 + 终态，不含 narrative text / workflow_node）
 *   2 = full（全部事件，含 Claude Code 风格 narrative；缺省）
 *
 * 惰性读取（同 getDataDir 模式），便于测试切换 + 运行时改 env 生效。
 * 见 docs/20-narrative-output-rules.md §七「已知限制」末尾的 verbose 说明。
 */
export function getLogVerbose(): number {
  const raw = Number(process.env.LIF_LOG_VERBOSE ?? "2");
  if (Number.isNaN(raw) || raw < 0) return 2;
  if (raw > 2) return 2;
  return Math.floor(raw);
}
