/**
 * finalize 后 review pass（C 层 —— 平台机制）。
 *
 * 用一次额外 LLM 调用（建议绑便宜模型，如 deepseek/haiku）对"证据-结论"链路
 * 做事后审计，挂可信度报告。成本可控（单次，非多 run 投票）。
 *
 * 设计：
 *   - 把 stepTrace 压成精简文本（thought + toolName + evidence 摘要），避免上下文爆炸
 *   - 用纯文本 prompt + JSON 文本输出（手动解析），兼容弱 provider（无 structured output）
 *   - 不阻断主结果：只产可信度报告（overClaims/unsupportedConclusions/evidenceGaps）
 *   - 失败时降级为 { skipped: true }，不抛错（review 是锦上添花，不该让主流程崩）
 *
 * 复用：summarizeEvidence()（EvidenceEnvelope → 简短描述）
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { StepTrace } from "./types.js";
import { isEvidenceEnvelope, summarizeEvidence } from "../core/evidence-envelope.js";
import { resolveCallSiteParams } from "../llm/llm-config.js";

/** review pass 产出的可信度报告。 */
export interface ReviewReport {
  /** 过度声明：结论超出了证据支撑范围。 */
  overClaims: string[];
  /** 无证据支撑的结论。 */
  unsupportedConclusions: string[];
  /** 证据缺口：还需补充哪些取证。 */
  evidenceGaps: string[];
  /** 整体可信度 0-1（1=证据充分无过度声明）。 */
  confidence: number;
  /** review 未执行（LLM 不可用/解析失败）时为 true。 */
  skipped?: boolean;
  /** 跳过/失败原因。 */
  skipReason?: string;
}

/** review pass 执行选项。 */
export interface ReviewPassOptions {
  /** 便宜模型实例（由 LlmService.model(callSite) 解析）。 */
  model: LanguageModel;
  /** 兼容模式（DeepSeek 等折叠 system 进 user）。 */
  compatMode?: boolean;
  /** AbortSignal。 */
  abortSignal?: AbortSignal;
}

/**
 * 执行一次 review pass。
 *
 * @param stepTrace  ReAct 主循环的完整轨迹
 * @param finalText  主循环的最终文本输出
 * @param options    模型 + 兼容模式
 * @returns          可信度报告（失败时 skipped:true，不抛错）
 */
export async function runReviewPass(
  stepTrace: StepTrace[],
  finalText: string,
  options: ReviewPassOptions,
): Promise<ReviewReport> {
  const { model, compatMode = false, abortSignal } = options;

  // 压缩 trace 为精简文本（避免上下文爆炸）
  const traceDigest = compressTrace(stepTrace);
  if (traceDigest === "" && !finalText) {
    return { overClaims: [], unsupportedConclusions: [], evidenceGaps: [], confidence: 1, skipped: true, skipReason: "trace 与 finalText 均为空，无需 review" };
  }

  const system = buildReviewSystemPrompt();
  const user = buildReviewUserPrompt(traceDigest, finalText);

  try {
    const callArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
      : { system, messages: [{ role: "user" as const, content: user }] };

    const { text } = await generateText({
      model,
      ...callArgs,
      temperature: resolveCallSiteParams("nexus_review").temperature,
      abortSignal,
    });

    return parseReviewReport(text);
  } catch (e) {
    // review 是锦上添花，失败不抛错
    const reason = e instanceof Error ? e.message : String(e);
    return { overClaims: [], unsupportedConclusions: [], evidenceGaps: [], confidence: 0, skipped: true, skipReason: reason };
  }
}

/**
 * 把 stepTrace 压成精简文本：每步的 thought 摘要 + 工具调用 + 证据徽章。
 * 跳过空步骤，截断过长的 thought。
 */
export function compressTrace(stepTrace: StepTrace[]): string {
  const lines: string[] = [];
  for (const step of stepTrace) {
    const parts: string[] = [];
    if (step.thought) {
      // 截断 thought 到 200 字，避免上下文爆炸
      const t = step.thought.length > 200 ? step.thought.slice(0, 200) + "…" : step.thought;
      parts.push(`Thought: ${t}`);
    }
    for (const tc of step.toolCalls) {
      if (tc.rejected) {
        parts.push(`Action: ${tc.toolName}(已拒绝)`);
        continue;
      }
      const evidenceTag = formatEvidenceTag(tc.result);
      parts.push(`Action: ${tc.toolName}${evidenceTag}`);
    }
    if (parts.length > 0) {
      lines.push(`[Step ${step.stepNumber}] ${parts.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

/** 工具结果若是 EvidenceEnvelope，附上简短徽章（来源/时效/置信度）。 */
function formatEvidenceTag(result: unknown): string {
  if (!isEvidenceEnvelope(result)) return "";
  return ` → ${summarizeEvidence(result)}`;
}

/** review system prompt：定义审计员角色 + 输出格式。 */
function buildReviewSystemPrompt(): string {
  return [
    "你是一个严谨的运营分析审计员。你的任务是审计一份 ReAct 分析轨迹，判断其结论是否被证据充分支撑。",
    "重点检查三类问题：",
    "1. overClaims（过度声明）：结论超出了证据支撑范围（如用 estimated 数据下确定性结论）",
    "2. unsupportedConclusions（无支撑结论）：结论找不到对应的工具取证",
    "3. evidenceGaps（证据缺口）：还需补充哪些取证才能让结论更可信",
    "",
    "## 输出格式",
    "只输出一个合法 JSON 对象，不要任何解释或 markdown 标记：",
    '{"overClaims":["..."],"unsupportedConclusions":["..."],"evidenceGaps":["..."],"confidence":0.0~1.0}',
    "confidence=1 表示证据充分无过度声明；越低问题越多。",
  ].join("\n");
}

/** review user prompt：注入压缩后的 trace + 最终文本。 */
function buildReviewUserPrompt(traceDigest: string, finalText: string): string {
  return [
    "## 分析轨迹（已压缩）",
    traceDigest || "(无工具调用轨迹)",
    "",
    "## 最终输出文本",
    finalText || "(无最终文本)",
    "",
    "## 任务",
    "审计上述结论是否被轨迹中的证据充分支撑。按指定 JSON 格式输出。",
  ].join("\n");
}

/**
 * 解析 review LLM 的 JSON 文本输出为 ReviewReport。
 * 容错：解析失败返回 skipped 报告（不抛错）。
 */
export function parseReviewReport(text: string): ReviewReport {
  const fallback: ReviewReport = {
    overClaims: [],
    unsupportedConclusions: [],
    evidenceGaps: [],
    confidence: 0,
    skipped: true,
    skipReason: "LLM 输出无法解析为 JSON",
  };
  if (!text || text.trim() === "") return fallback;

  // 尝试提取首个 JSON 对象（容错 markdown 代码块包裹）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const asArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)) : [];
    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
    return {
      overClaims: asArr(parsed.overClaims),
      unsupportedConclusions: asArr(parsed.unsupportedConclusions),
      evidenceGaps: asArr(parsed.evidenceGaps),
      confidence,
    };
  } catch {
    return fallback;
  }
}
