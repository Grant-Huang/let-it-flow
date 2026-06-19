import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir } from "../core/config.js";
import type { CallSite } from "./call-sites.js";

/**
 * LLM 调用事件（见 docs/13-p8-config-and-observability.md §13.5.1）。
 *
 * 每次 LLM 调用（成功/失败）产出一条。敏感信息防护：
 *   - 不记录 prompt 内容、completion 文本、API key
 *   - 只记 token 数 + 元数据
 *   - 错误信息截断到 200 字符
 */
export interface LlmCallEvent {
  /** 事件类型固定为 "llm_call" */
  type: "llm_call";
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 调用点 */
  callSite: CallSite;
  /** 任务 id（异步任务上下文） */
  taskId?: string;
  /** DAG 节点 id（执行器内调用时） */
  nodeId?: string;
  /** 实际使用的模型 alias */
  modelAlias: string;
  /** provider 内部模型 id */
  modelId: string;
  /** provider 类型 */
  provider: string;
  /** 输入 token 数 */
  promptTokens?: number;
  /** 输出 token 数 */
  completionTokens?: number;
  /** 总 token 数 */
  totalTokens?: number;
  /** 耗时（毫秒） */
  latencyMs: number;
  /** 估算成本（美元）。基于 registry pricing 计算 */
  estimatedCostUsd?: number;
  /** 调用参数 */
  params: { temperature?: number; maxTokens?: number; topP?: number };
  /** 是否走 RobustOutputGuard */
  robustGuard: boolean;
  /** 是否成功 */
  ok: boolean;
  /** 失败时的错误类型 */
  errorKind?: "timeout" | "auth" | "rate_limit" | "network" | "parse" | "schema" | "other";
  /** 失败时的错误摘要（截断到 200 字符） */
  errorMessage?: string;
  /** 重试信息（0=首次，1+=重试） */
  retryAttempt?: number;
}

/**
 * 错误分类：把 AI SDK 抛的错误映射到 errorKind。
 */
export function classifyError(e: unknown): LlmCallEvent["errorKind"] {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("api key") || lower.includes("auth") || lower.includes("401")) return "auth";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return "network";
  }
  if (lower.includes("json") || lower.includes("parse")) return "parse";
  if (lower.includes("schema") || lower.includes("validation")) return "schema";
  return "other";
}

/** 截断字符串到指定长度。 */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * ndjson 落库写入器。每次 append 一行 JSON 到 data/tasks/<taskId>/llm_calls.ndjson。
 *
 * 设计：
 *   - 每任务一个文件，便于回溯
 *   - append 模式，不缓冲（避免进程崩溃丢日志）
 *   - 同步写（IO 量小，每次 LLM 调用才写一次）
 */
export class CallLogWriter {
  constructor(private readonly dataDir: string = getTasksDir().replace("/tasks", "")) {}

  /** 追加一条事件到任务的 ndjson 日志。 */
  append(taskId: string, event: LlmCallEvent): Promise<void> {
    return Promise.resolve().then(() => {
      // dataDir 是 LIF_DATA_DIR；tasks 目录是 dataDir/tasks
      const dir = join(this.dataDir, "tasks", taskId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "llm_calls.ndjson");
      // 截断 errorMessage
      const toWrite: LlmCallEvent = event.errorMessage
        ? { ...event, errorMessage: truncate(event.errorMessage, 200) }
        : event;
      appendFileSync(path, JSON.stringify(toWrite) + "\n", "utf8");
    });
  }
}
