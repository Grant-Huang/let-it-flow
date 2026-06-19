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
  /** 端口 */
  port: Number(process.env.PORT ?? 8787),
} as const;
