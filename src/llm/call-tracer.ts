import type { LanguageModel } from "ai";
import type { CallSite } from "./call-sites.js";
import { type LlmCallEvent, classifyError } from "./call-log.js";
import { computeCost } from "./cost-compute.js";

/**
 * tracedGenerateText 包装（见 docs/13-p8-config-and-observability.md §13.5.2）。
 *
 * 业务代码经此包装调 LLM，自动产出 LlmCallEvent。
 * 成功返回原结果；失败产出失败事件后重抛原错误。
 *
 * 敏感信息防护：不记录 prompt/completion 文本，只记 token 数 + 元数据。
 */

/** tracing 上下文：调用点 + 模型元信息 + 任务关联。 */
export interface TraceContext {
  callSite: CallSite;
  modelAlias: string;
  provider: string;
  taskId?: string;
  nodeId?: string;
  /** 用于成本计算的 pricing（来自 registry） */
  pricing?: { inputPer1K: number; outputPer1K: number };
  params?: { temperature?: number; maxTokens?: number; topP?: number };
  robustGuard?: boolean;
  retryAttempt?: number;
}

/**
 * 包装 generateText，自动埋点。
 *
 * @param model       AI SDK LanguageModel
 * @param callArgs    generateText 的原参数（除 model 外）
 * @param trace       tracing 上下文
 * @param onCall      事件回调（落库 / 上报）
 */
export async function tracedGenerateText(
  model: LanguageModel,
  callArgs: Record<string, unknown>,
  trace: TraceContext,
  onCall: (event: LlmCallEvent) => void,
): Promise<{ text: string; usage: Record<string, number | undefined> }> {
  const startedAt = Date.now();
  const { generateText } = await import("ai");
  let event: LlmCallEvent | undefined;

  try {
    const result = await generateText({ model, ...callArgs } as never);
    const usage = (result.usage ?? {}) as unknown as Record<string, number | undefined>;
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
    const totalTokens = usage.totalTokens;
    event = {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: trace.callSite,
      taskId: trace.taskId,
      nodeId: trace.nodeId,
      modelAlias: trace.modelAlias,
      modelId: (model as unknown as { modelId?: string }).modelId ?? "unknown",
      provider: trace.provider,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: computeCost({ promptTokens, completionTokens, totalTokens }, trace.pricing),
      params: trace.params ?? {},
      robustGuard: trace.robustGuard ?? false,
      retryAttempt: trace.retryAttempt,
      ok: true,
    };
    return { text: result.text, usage: { promptTokens, completionTokens, totalTokens } };
  } catch (e) {
    event = {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: trace.callSite,
      taskId: trace.taskId,
      nodeId: trace.nodeId,
      modelAlias: trace.modelAlias,
      modelId: (model as unknown as { modelId?: string }).modelId ?? "unknown",
      provider: trace.provider,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: undefined,
      params: trace.params ?? {},
      robustGuard: trace.robustGuard ?? false,
      retryAttempt: trace.retryAttempt,
      ok: false,
      errorKind: classifyError(e),
      errorMessage: e instanceof Error ? e.message : String(e),
    };
    throw e;
  } finally {
    if (event) onCall(event);
  }
}
