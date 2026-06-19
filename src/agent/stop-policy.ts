/**
 * 循环停止策略（E 层）。
 *
 * 把 StopPolicyConfig 转成 AI SDK v6 的 stopWhen 条件数组。
 * SDK 提供三个内置条件：stepCountIs / hasToolCall / isLoopFinished。
 * 成本上限通过自定义谓词实现（扫描 step 历史）。
 *
 * 注意：stopWhen 在 SDK v6 是组合条件，任一满足即终止。
 */
import { stepCountIs, hasToolCall } from "ai";
import type { StopPolicyConfig } from "./types.js";

/**
 * SDK 的 StopCondition 是泛型 `StopCondition<TOOLS>`，且其谓词签名里的 steps 是
 * `ReadonlyArray<StepResult<TOOLS>>`。harness 需要泛型无关的统一类型，故用别名
 * 收敛为 any 参数化形态，避免每个调用点都带泛型。
 */
type AnyStopCondition = (opts: {
  steps: ReadonlyArray<{
    usage: { inputTokens?: number; outputTokens?: number };
  }>;
}) => boolean;

/** 缺省值。 */
export const DEFAULT_MAX_STEPS = 15;
export const DEFAULT_FINALIZE_TOOL = "nexus_finalize";

/**
 * 把 StopPolicyConfig 编译成 AI SDK 的 stopWhen 条件数组。
 * @param config  停止策略配置（undefined 用缺省）
 * @param extra   额外的自定义条件（如 precondition 触发）
 */
export function buildStopWhen(
  config?: StopPolicyConfig,
  extra: AnyStopCondition[] = [],
): AnyStopCondition[] {
  const maxSteps = config?.maxSteps ?? DEFAULT_MAX_STEPS;
  const finalizeTool = config?.finalizeTool ?? DEFAULT_FINALIZE_TOOL;
  const conditions: AnyStopCondition[] = [
    stepCountIs(maxSteps) as unknown as AnyStopCondition,
    hasToolCall(finalizeTool) as unknown as AnyStopCondition,
  ];

  // 成本上限：自定义谓词检查累计 token
  if (config?.costCap) {
    const cap = config.costCap;
    conditions.push((opts) => {
      const totalInput = opts.steps.reduce(
        (sum, s) => sum + (s.usage.inputTokens ?? 0),
        0,
      );
      const totalOutput = opts.steps.reduce(
        (sum, s) => sum + (s.usage.outputTokens ?? 0),
        0,
      );
      if (cap.maxInputTokens && totalInput >= cap.maxInputTokens) return true;
      if (cap.maxOutputTokens && totalOutput >= cap.maxOutputTokens) return true;
      return false;
    });
  }

  return [...conditions, ...extra];
}
