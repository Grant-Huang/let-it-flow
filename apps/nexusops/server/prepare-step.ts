/**
 * NexusOps prepareStep 钩子（E+V 层内容 —— 应用注入，harness 每步前调用）。
 *
 * 两个职责（集中在一个 prepareStep 里实现，见计划决策 #2）：
 *   1. 动态裁工具（activeTools）：扫描已执行 trace 的 toolCall 工具名，推断当前
 *      诊断域，只保留该域 + core 通用工具 + nexus 收尾工具，裁掉无关 domain。
 *      降幻觉、提一致性（工具越多 LLM 越易跑偏）。
 *   2. every_step precondition 提示注入：调用 collectEveryStepReminders，把
 *      "取证不足"的提示注入 system 字段，让 LLM 在下一步补取证（而非拖到 finalize）。
 *
 * 触发纪律：只在"已识别出主导域"时裁工具，否则返回全部工具（避免过早收窄）。
 */
import type { PrepareStepContext, PrepareStepResult } from "../../../src/agent/types.js";
import { collectEveryStepReminders } from "./preconditions.js";

/** NexusOps domain 工具前缀（按工具名第一个点分段）。 */
const DOMAIN_PREFIXES = [
  "oee",
  "equipment",
  "quality",
  "process",
  "energy",
  "schedule",
  "material",
] as const;

/** core 通用工具（裁域时始终保留）。 */
const CORE_KEEP = new Set(["core.web_search", "core.web_fetch", "core.knowledge_base"]);

/** nexus 收尾/建议工具（始终保留）。 */
const NEXUS_KEEP = new Set(["nexus_finalize", "nexus_advise"]);

/** skill 工具（始终保留，沉淀流程跨域复用）。 */
const SKILL_PREFIX = "skill.";

/** 主导域判定阈值：某域工具调用占比超过此值则认定主导（严格多数，平局不算）。 */
const DOMINANT_RATIO = 0.5;

/**
 * 从已执行 trace 推断当前主导诊断域。
 * @returns 主导域前缀（如 "oee"），无主导时返回 undefined。
 */
function detectDominantDomain(steps: PrepareStepContext["steps"]): string | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      if (tc.rejected) continue;
      const prefix = tc.toolName.split(".")[0];
      if (!prefix) continue;
      // 只统计 domain 工具（排除 core/nexus/skill）
      if ((DOMAIN_PREFIXES as readonly string[]).includes(prefix)) {
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        total++;
      }
    }
  }
  if (total === 0) return undefined;
  let dominant: string | undefined;
  let dominantCount = 0;
  for (const [prefix, count] of counts) {
    if (count > dominantCount) {
      dominant = prefix;
      dominantCount = count;
    }
  }
  if (!dominant) return undefined;
  // 主导域工具调用占比必须严格超过半数（平局不算主导，避免误裁）
  if (dominantCount / total <= DOMINANT_RATIO) return undefined;
  return dominant;
}

/**
 * 构造 NexusOps 的 prepareStep 函数。
 *
 * @param allToolNames  harness 暴露给 LLM 的全部工具名（用于裁剪后返回 activeTools）
 * @returns  prepareStep 函数，注入 harness 的 HarnessConfig.prepareStep
 */
export function buildNexusPrepareStep(
  allToolNames: string[],
): (ctx: PrepareStepContext) => PrepareStepResult | undefined {
  return (ctx: PrepareStepContext): PrepareStepResult | undefined => {
    const result: PrepareStepResult = {};

    // 1. 动态裁工具：识别主导域后只保留相关工具
    const dominant = detectDominantDomain(ctx.steps);
    if (dominant) {
      result.activeTools = allToolNames.filter((name) => {
        const prefix = name.split(".")[0];
        // 主导域 + core 通用 + nexus 收尾 + skill 全留
        return (
          prefix === dominant ||
          CORE_KEEP.has(name) ||
          NEXUS_KEEP.has(name) ||
          name.startsWith(SKILL_PREFIX)
        );
      });
    }

    // 2. every_step precondition 提示注入
    const reminders = collectEveryStepReminders(ctx.steps);
    if (reminders.length > 0) {
      result.system = `## 前置条件提醒（每步检查）\n${reminders.map((r) => `- ${r}`).join("\n")}\n\n请在下一步优先补齐上述取证，不要在证据不足时给结论。`;
    }

    // 两个都没产出 → 返回 undefined（harness 用缺省全工具 + 无额外 system）
    if (!result.activeTools && !result.system) return undefined;
    return result;
  };
}
