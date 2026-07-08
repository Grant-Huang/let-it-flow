import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_PORT } from "./ports.js";

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
  /** Embedding API Key（独立于 chat provider；缺省回退 openaiApiKey）。 */
  embeddingApiKey: process.env.LIF_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  /** Embedding baseURL（独立配置，如 Jina: https://api.jina.ai/v1）。缺省回退 openaiBaseUrl / OpenAI 官方。 */
  embeddingBaseUrl: process.env.LIF_EMBEDDING_BASE_URL ?? "",
  /** Embedding 模型 id（缺省 text-embedding-3-small；Jina 用 jina-embeddings-v3）。 */
  embeddingModel: process.env.LIF_EMBEDDING_MODEL ?? "text-embedding-3-small",
  /** Tavily 搜索 API Key（web_search 用） */
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  /** 搜索 provider 选择：native=强制 DuckDuckGo / tavily=强制 Tavily / auto=有 key 用 Tavily（默认） */
  searchProvider: process.env.LIF_SEARCH_PROVIDER ?? "auto",
  /** 端口（集中自 ports.ts，避免 8787 散落） */
  port: CORE_PORT,
} as const;

/**
 * 外部服务 base URL 集中配置（便于切换环境/代理/私有部署）。
 *
 * 所有第三方 API endpoint 在此声明，业务代码统一引用 SERVICE_URLS.* 而非散落字面量。
 * 优先级：环境变量 > 默认值。新增外部依赖时在此追加字段。
 */
export const SERVICE_URLS = {
  /** Tavily 搜索 API（web-search.ts 用）。env: TAVILY_BASE_URL。 */
  tavilySearch: process.env.TAVILY_BASE_URL ?? "https://api.tavily.com/search",
  /** DuckDuckGo HTML 检索端点（无 key 兜底）。env: DDG_HTML_BASE_URL。 */
  duckduckgoHtml: process.env.DDG_HTML_BASE_URL ?? "https://html.duckduckgo.com/html/",
  /** 微信公众号开放平台 API 基址。env: WECHAT_API_BASE。 */
  wechatApi: process.env.WECHAT_API_BASE ?? "https://api.weixin.qq.com",
  /** Ollama 本地推理服务基址（OpenAI 兼容路径）。env: OLLAMA_BASE_URL。 */
  ollama: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
} as const;

/**
 * 日志落盘开关（控制 events.jsonl / llm_calls.ndjson 是否写入磁盘）：
 *   false = off（完全不写日志文件；仅内存实时分发）
 *   true  = on（全部事件落盘；缺省）
 *
 * 注意：此开关只影响「是否落盘」，不影响 SSE 实时推送与会话框渲染——
 * 前端实时显示在两种模式下完全一致（走 EventBroadcaster 内存广播）。
 * 历史会话回放仍读落盘文件，off 模式下历史会话将无法重建（这是 off 的本质）。
 *
 * 取值规则（env: LIF_LOG_PERSIST）：
 *   - 缺省 / 非法值 → true（on，安全缺省）
 *   - "0" / "false" / "off" / 负数 → false（off）
 *   - 其它非空值 → true（on）
 *
 * 惰性读取（同 getDataDir 模式），便于测试切换 + 运行时改 env 生效。
 */
export function getLogPersist(): boolean {
  const raw = process.env.LIF_LOG_PERSIST ?? "true";
  const lower = raw.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "off") return false;
  const num = Number(raw);
  if (!Number.isNaN(num) && num <= 0) return false;
  return true;
}
