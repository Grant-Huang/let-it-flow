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
import type { LanguageModel } from "ai";
import type { PrepareStepContext, PrepareStepResult } from "../../../src/agent/types.js";
import { collectEveryStepReminders } from "./preconditions.js";
import { evaluateEvidenceGate } from "../../../src/agent/evidence-gate.js";

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
 * @param allToolNames          harness 暴露给 LLM 的全部工具名（用于裁剪后返回 activeTools）
 * @param evidenceGateModel     收尾前证据评估模型（主力模型）。缺省则不做语义评估
 * @param evidenceGateCompatMode 评估模型兼容模式
 * @returns  prepareStep 函数，注入 harness 的 HarnessConfig.prepareStep
 */
export function buildNexusPrepareStep(
  allToolNames: string[],
  evidenceGateModel?: LanguageModel,
  evidenceGateCompatMode?: boolean,
): (ctx: PrepareStepContext) => Promise<PrepareStepResult | undefined> | PrepareStepResult | undefined {
  return async (ctx: PrepareStepContext): Promise<PrepareStepResult | undefined> => {
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

    // 3. 收尾意图检测 + 证据充分性评估（语义级，主力模型）
    //    仅当模型尝试收尾时触发，控制延迟（典型 1-2 次/会话）
    if (evidenceGateModel) {
      const gateVerdict = await tryEvaluateEvidenceGate(ctx, evidenceGateModel, evidenceGateCompatMode);
      if (gateVerdict) {
        applyGateVerdict(gateVerdict, result, allToolNames);
      }
    }

    // 三个都没产出 → 返回 undefined（harness 用缺省全工具 + 无额外 system）
    if (!result.activeTools && !result.system) return undefined;
    return result;
  };
}

/** 收尾意图检测：上一步是否调了 finalize 或没调任何工具（想自然停止）。 */
function isFinalizeAttempt(steps: PrepareStepContext["steps"]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  // 没调任何工具的步骤（finishReason=stop）= 想自然收尾
  if (last.toolCalls.length === 0) return true;
  // 调了 nexus_finalize（key 形态 nexus.finalize 也匹配）
  return last.toolCalls.some(
    (tc) => tc.toolName === "nexus_finalize" || tc.toolName === "nexus.finalize",
  );
}

/** 触发证据评估（仅收尾意图时），返回评估结论或 null（未触发/无轨迹/放行）。 */
async function tryEvaluateEvidenceGate(
  ctx: PrepareStepContext,
  model: LanguageModel,
  compatMode?: boolean,
): Promise<{ action: "soft_warn" | "block"; confidence: number; evidenceGaps: string[]; overClaims: string[] } | null> {
  if (!isFinalizeAttempt(ctx.steps)) return null;
  // 首步即收尾（如澄清反问）无取证轨迹，跳过评估
  const hasEvidence = ctx.steps.some((s) => s.toolCalls.length > 0);
  if (!hasEvidence) return null;

  const verdict = await evaluateEvidenceGate(ctx.steps, ctx.intent, {
    model,
    compatMode,
  });
  if (verdict.action === "pass") return null; // 放行不干预
  return {
    action: verdict.action,
    confidence: verdict.confidence,
    evidenceGaps: verdict.evidenceGaps,
    overClaims: verdict.overClaims,
  };
}

/** 把评估结论应用到 prepareStep 结果（软提示或硬阻断）。 */
function applyGateVerdict(
  verdict: { action: "soft_warn" | "block"; confidence: number; evidenceGaps: string[]; overClaims: string[] },
  result: PrepareStepResult,
  allToolNames: string[],
): void {
  const gapsText = verdict.evidenceGaps.length > 0
    ? `\n证据缺口：\n${verdict.evidenceGaps.map((g) => `- ${g}`).join("\n")}`
    : "";
  const claimsText = verdict.overClaims.length > 0
    ? `\n可能的过度声明：\n${verdict.overClaims.map((c) => `- ${c}`).join("\n")}`
    : "";

  if (verdict.action === "block") {
    // 硬阻断：从 activeTools 移除 nexus_finalize，模型这一步看不到收尾工具
    result.activeTools = (result.activeTools ?? allToolNames).filter((n) => n !== "nexus_finalize");
    result.system = `## 证据不足，禁止收尾（评估 confidence=${verdict.confidence.toFixed(2)}）${gapsText}${claimsText}\n\n请继续取证补齐上述缺口后再收尾。可参考系统提示中的"证据源地图"选择合适的取证工具。`;
  } else {
    // soft_warn：保留 finalize 但注入警告，主模型自己决定
    const warnText = `## 证据充分性提醒（confidence=${verdict.confidence.toFixed(2)}）${gapsText}${claimsText}\n\n若证据已足够支撑结论可收尾，否则建议先补取证（可参考系统提示中的"证据源地图"）。`;
    result.system = result.system ? `${result.system}\n\n${warnText}` : warnText;
  }
}
