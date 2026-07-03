/**
 * 收尾前证据充分性评估（V 层增强 —— 在模型尝试收尾时做语义级证据判断）。
 *
 * 解决"获得新数据后是否需要追加取证"的核心痛点：现有 every_step 前置条件只检查
 * "调没调过某前缀工具"（刚性），不看证据内容质量（如 confidence=inferred 的弱证据
 * 照样放行）。本模块在模型表现出收尾意图时（调了 nexus_finalize 或没调任何工具），
 * 用主力模型对当前轨迹做开放式语义评估，返回 confidence 分级处理：
 *   - ≥0.7 充分 → 放行收尾
 *   - 0.4-0.7 存疑 → 注入软提示，主模型自己决定
 *   - <0.4 不足 → 硬阻断（prepareStep 从 activeTools 移除 nexus_finalize）
 *
 * 设计（与 review-pass.ts 对齐，同为"主力模型一次性 generateText"模式）：
 *   - 复用 compressTrace（轨迹压缩）和 parseReviewReport（JSON 解析）
 *   - 区别：触发时机在收尾前（review-pass 是 finalize 后事后审计）；
 *           输入无 finalText（结论还没产出），改为基于意图判断证据充分性
 *   - 失败降级返回 action="pass"（不阻断，与 review-pass 容错原则一致）
 *   - 纯文本 prompt + JSON 输出（兼容弱 provider）
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { StepTrace } from "./types.js";
import { compressTrace, parseReviewReport } from "./review-pass.js";
import { resolveCallSiteParams } from "../llm/llm-config.js";

/** 证据评估执行选项。 */
export interface EvidenceGateOptions {
  /** 主力模型实例（由 LlmService.model("nexus_agent") 解析）。 */
  model: LanguageModel;
  /** 兼容模式（DeepSeek 等折叠 system 进 user）。 */
  compatMode?: boolean;
  /** AbortSignal。 */
  abortSignal?: AbortSignal;
}

/** 评估结论动作（分级处理）。 */
export type EvidenceGateAction = "pass" | "soft_warn" | "block";

/** 证据评估产出。 */
export interface EvidenceGateResult {
  /** 分级动作：放行 / 软提示 / 硬阻断。 */
  action: EvidenceGateAction;
  /** 评估模型给的 confidence 0-1。 */
  confidence: number;
  /** 证据缺口描述（注入给主模型作为补取证指引）。 */
  evidenceGaps: string[];
  /** 过度声明（注入给主模型）。 */
  overClaims: string[];
  /** 评估未执行（模型不可用/解析失败）时为 true，action=pass 放行不阻断。 */
  skipped?: boolean;
}

/** 分级阈值（流程控制参数，非领域知识）。 */
const CONFIDENCE_PASS_THRESHOLD = 0.7;
const CONFIDENCE_BLOCK_THRESHOLD = 0.4;

/**
 * 对当前轨迹做收尾前证据充分性评估。
 *
 * @param stepTrace  当前已执行的完整轨迹
 * @param intent     用户原始意图（评估"证据是否支撑针对该意图的结论"）
 * @param options    模型 + 兼容模式
 * @returns          分级评估结果（失败时 skipped:true, action:"pass" 不阻断）
 */
export async function evaluateEvidenceGate(
  stepTrace: StepTrace[],
  intent: string,
  options: EvidenceGateOptions,
): Promise<EvidenceGateResult> {
  const { model, compatMode = false, abortSignal } = options;

  const traceDigest = compressTrace(stepTrace);
  if (traceDigest === "") {
    // 无任何轨迹（空轨迹不该出现在收尾意图场景，保守放行）
    return {
      action: "pass",
      confidence: 1,
      evidenceGaps: [],
      overClaims: [],
      skipped: true,
    };
  }

  const system = buildGateSystemPrompt();
  const user = buildGateUserPrompt(intent, traceDigest);

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

    const report = parseReviewReport(text);
    if (report.skipped) {
      // 解析失败 → 降级放行
      return {
        action: "pass",
        confidence: 0,
        evidenceGaps: [],
        overClaims: [],
        skipped: true,
      };
    }

    const action = resolveAction(report.confidence);
    return {
      action,
      confidence: report.confidence,
      evidenceGaps: report.evidenceGaps,
      overClaims: report.overClaims,
    };
  } catch {
    // 评估是锦上添花，失败不阻断主流程（与 review-pass 一致）
    return {
      action: "pass",
      confidence: 0,
      evidenceGaps: [],
      overClaims: [],
      skipped: true,
    };
  }
}

/** 按 confidence 分级判定动作。导出便于单测覆盖阈值边界。 */
export function resolveAction(confidence: number): EvidenceGateAction {
  if (confidence >= CONFIDENCE_PASS_THRESHOLD) return "pass";
  if (confidence >= CONFIDENCE_BLOCK_THRESHOLD) return "soft_warn";
  return "block";
}

/** 评估 system prompt：定义证据评估员角色 + 输出格式。 */
function buildGateSystemPrompt(): string {
  return [
    "你是一个严谨的运营分析证据评估员。你的任务：在分析师准备给出最终结论前，",
    "审计当前已收集的证据是否充分支撑针对用户意图的结论。",
    "",
    "重点判断三类问题：",
    "1. overClaims（过度声明）：基于现有证据，分析师可能得出的超出证据支撑范围的结论",
    "2. unsupportedConclusions（无支撑结论）：现有轨迹里找不到对应工具取证就下的结论",
    "3. evidenceGaps（证据缺口）：还需补充哪些取证才能让结论可信（具体到该查哪个域/指标）",
    "",
    "评估 confidence 时考虑：",
    "- 证据时效性（realtime > estimated > inferred，inferred 证据需交叉验证）",
    "- 证据覆盖度（意图涉及的核心指标是否都取了证）",
    "- 证据一致性（不同来源的数据是否互相矛盾）",
    "",
    "## 输出格式",
    "只输出一个合法 JSON 对象，不要任何解释或 markdown 标记：",
    '{"overClaims":["..."],"unsupportedConclusions":["..."],"evidenceGaps":["..."],"confidence":0.0~1.0}',
    "confidence=1 表示证据充分可直接结论；越低表示证据越不足，需要更多取证。",
  ].join("\n");
}

/** 评估 user prompt：注入用户意图 + 压缩后的取证轨迹。 */
function buildGateUserPrompt(intent: string, traceDigest: string): string {
  return [
    "## 用户意图",
    intent || "(意图未明确)",
    "",
    "## 当前取证轨迹（已压缩）",
    traceDigest,
    "",
    "## 任务",
    "分析师准备收尾给结论了。基于上述轨迹判断：证据是否充分支撑针对该意图的结论？",
    "若不充分，evidenceGaps 指出具体还需补哪些取证。按指定 JSON 格式输出。",
  ].join("\n");
}
