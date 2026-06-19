/**
 * 成本计算（见 docs/13-p8-config-and-observability.md §13.5）。
 *
 * 根据 ModelEndpoint.pricing 和 token usage 估算美元成本。
 */

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface Pricing {
  inputPer1K: number;
  outputPer1K: number;
}

/**
 * 计算单次调用成本。
 * @param usage   provider 返回的 token 用量
 * @param pricing 模型单价（美元 / 1K token）。无则返回 undefined
 * @returns 美元成本，或 undefined（无 pricing 时）
 */
export function computeCost(
  usage: TokenUsage,
  pricing: Pricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  return (input / 1000) * pricing.inputPer1K + (output / 1000) * pricing.outputPer1K;
}
