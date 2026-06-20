/**
 * nexus_advise 输出结构自检（B3 —— 输出侧可信度门）。
 *
 * 对称于 V 层 precondition（输入侧门）：precondition 保证"答前取证"，
 * validateAdvise 保证"建议产出后结构合规"。LLM 在 system prompt 被告知字段
 * 约束（impact/executionScore/confidence 在 0-1），但这是概率性合规；
 * 本校验是确定性约束：不达标则工具返回 { invalid: true, reasons }，LLM 被迫修正。
 *
 * 校验项：
 *   1. 字段完整性：title/rationale/impact/executionScore/confidence 必填
 *   2. 数值范围：impact/executionScore/confidence 必须在 [0, 1]
 *   3. 证据引用：evidenceRefs 缺失时记 warn（不阻断，但提示 LLM 补引用）
 */

/** 单条建议的预期结构（宽松类型，适配 LLM 产出）。 */
interface Recommendation {
  title?: unknown;
  rationale?: unknown;
  impact?: unknown;
  executionScore?: unknown;
  confidence?: unknown;
  actionTool?: unknown;
  evidenceRefs?: unknown;
  [k: string]: unknown;
}

/** 校验结果。 */
export interface AdviseValidation {
  valid: boolean;
  reasons: string[];
  /** evidenceRefs 缺失的 warn（不阻断 valid，但 LLM 应改进）。 */
  evidenceRefWarnings: string[];
}

/** 数值是否在 [0, 1]。 */
function inUnitRange(v: unknown): boolean {
  return typeof v === "number" && v >= 0 && v <= 1;
}

/**
 * 校验建议列表的结构合规性。
 * @param recs  建议数组（来自 nexus_advise 的 params.recommendations）
 * @returns valid=false 时 reasons 非空，工具应返回 { invalid: true, reasons }
 */
export function validateAdvise(recs: unknown[]): AdviseValidation {
  const reasons: string[] = [];
  const evidenceRefWarnings: string[] = [];

  if (recs.length === 0) {
    return {
      valid: false,
      reasons: ["recommendations 为空，至少产出 1 条建议"],
      evidenceRefWarnings: [],
    };
  }

  recs.forEach((raw, i) => {
    const rec = (raw ?? {}) as Recommendation;
    const label = `建议 #${i + 1}${typeof rec.title === "string" ? `（${rec.title}）` : ""}`;

    // 1. 字段完整性
    const required: Array<keyof Recommendation> = [
      "title",
      "rationale",
      "impact",
      "executionScore",
      "confidence",
    ];
    for (const field of required) {
      const v = rec[field];
      if (v === undefined || v === null || v === "") {
        reasons.push(`${label} 缺少必填字段 ${String(field)}`);
      }
    }

    // title / rationale 必须是非空字符串
    if (typeof rec.title !== "string" || rec.title.trim() === "") {
      reasons.push(`${label} 的 title 必须是非空字符串`);
    }
    if (typeof rec.rationale !== "string" || rec.rationale.trim() === "") {
      reasons.push(`${label} 的 rationale 必须是非空字符串`);
    }

    // 2. 数值范围 [0, 1]
    if (!inUnitRange(rec.impact)) {
      reasons.push(`${label} 的 impact 必须是 [0,1] 内的数值（实际：${JSON.stringify(rec.impact)}）`);
    }
    if (!inUnitRange(rec.executionScore)) {
      reasons.push(`${label} 的 executionScore 必须是 [0,1] 内的数值（实际：${JSON.stringify(rec.executionScore)}）`);
    }
    if (!inUnitRange(rec.confidence)) {
      reasons.push(`${label} 的 confidence 必须是 [0,1] 内的数值（实际：${JSON.stringify(rec.confidence)}）`);
    }

    // 3. 证据引用（warn，不阻断）
    const refs = rec.evidenceRefs;
    if (!Array.isArray(refs) || refs.length === 0) {
      evidenceRefWarnings.push(
        `${label} 未提供 evidenceRefs，建议补充支撑证据的工具名/来源（如 oee.realtime）`,
      );
    }
  });

  return {
    valid: reasons.length === 0,
    reasons,
    evidenceRefWarnings,
  };
}
