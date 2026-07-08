/**
 * 轨迹压缩器（R5 平台基础设施）。
 *
 * 把 NexusOps boot.ts:1037-1046 自实现的 compressTrace 逻辑回归到平台层。
 * 当前实现完全复刻 review-pass.ts 的 compressTrace（move 而非 rewrite），
 * 保证 review-pass.ts 改为 re-import 后行为字节级一致（见 test-trace-compressor.ts 的回归保障用例）。
 *
 * 设计：
 *   - 接口 + 默认实现（DefaultTraceCompressor）
 *   - 纯函数版本 compressTrace（向后兼容，review-pass.ts 复用）
 *   - thought 截断到 200 字、EvidenceEnvelope 附徽章、rejected 标记
 */
import type { StepTrace } from "./types.js";
import { isEvidenceEnvelope, summarizeEvidence } from "../core/evidence-envelope.js";

/** thought 截断阈值（与 review-pass.ts 现有硬编码一致）。 */
const THOUGHT_MAX_CHARS = 200;

/** 压缩后的轨迹 digest（供多轮追问作为 user 消息前置段落）。 */
export interface TraceDigest {
  /** 上一轮用户意图（可选，由调用方提供）。 */
  intent?: string;
  /** 压缩后的轨迹文本（[Step N] Thought: ... | Action: tool → evidence）。 */
  traceDigest: string;
  /** 上一轮最终结论。 */
  finalText: string;
}

/** 压缩器接口（应用可注入自定义实现，如未来用 LLM 摘要替代截断）。 */
export interface TraceCompressor {
  compress(steps: StepTrace[], finalText: string, opts?: { intent?: string }): TraceDigest;
}

/**
 * 默认压缩器：复刻 review-pass.ts 的 compressTrace 策略。
 *
 * 策略：
 *   - thought 截断到 200 字 + 省略号
 *   - 工具结果若是 EvidenceEnvelope，附 summarizeEvidence 徽章
 *   - rejected 工具调用标记 (已拒绝)
 *   - 跳过空步骤（无 thought 且无工具调用）
 */
export class DefaultTraceCompressor implements TraceCompressor {
  compress(steps: StepTrace[], finalText: string, opts?: { intent?: string }): TraceDigest {
    return {
      intent: opts?.intent,
      traceDigest: compressTrace(steps),
      finalText,
    };
  }
}

/**
 * 把 stepTrace 压成精简文本：每步的 thought 摘要 + 工具调用 + 证据徽章。
 * 跳过空步骤，截断过长的 thought。
 *
 * 注：此函数从 review-pass.ts 迁移而来，review-pass.ts 现从本模块 re-import（保持向后兼容）。
 */
export function compressTrace(stepTrace: StepTrace[]): string {
  const lines: string[] = [];
  for (const step of stepTrace) {
    // 防御性：从 events.jsonl 还原的 step 可能缺字段，容错跳过
    if (!step || !Array.isArray(step.toolCalls)) continue;
    const parts: string[] = [];
    if (step.thought) {
      // 截断 thought 到 200 字，避免上下文爆炸
      const t =
        step.thought.length > THOUGHT_MAX_CHARS
          ? step.thought.slice(0, THOUGHT_MAX_CHARS) + "…"
          : step.thought;
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
