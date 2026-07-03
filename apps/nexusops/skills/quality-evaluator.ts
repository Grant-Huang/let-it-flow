/**
 * LLM 结果质量评估器（Phase 4.6）。
 *
 * 用便宜模型对一次分析的最终产出做多维评分，输出评估报告。
 *
 * 评估维度（每个 0-10 分 + 理由）：
 *   - 主题一致性：分析主题是否贯穿始终，有无漂移
 *   - 证据充分性：核心结论是否有足够工具调用支撑
 *   - 根因合理性：根因是否符合 5Why 逻辑，鱼骨图覆盖 5M1E（诊断类适用）
 *   - 建议可执行性：建议项是否带 actionTool + impact/executionScore
 *   - 方法合规性：是否遵循方法论的阶段顺序
 *
 * 评估报告本身也是 ComponentLayout（用 score-card + reasoning-table 渲染）。
 */
import { generateText, type LanguageModel } from "ai";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";
import { createSkill } from "../../../src/agent/skill-bridge.js";
import type { ComponentLayout } from "../../../src/orchestrator/report-types.js";
import { renderReport } from "./report-renderer.js";

/** 单维度评分。 */
export interface DimensionScore {
  name: string;
  score: number;       // 0-10
  reason: string;
}

/** 质量评估结果。 */
export interface QualityAssessment {
  /** 总评分（各维度平均，0-10）。 */
  overall: number;
  /** 各维度评分。 */
  dimensions: DimensionScore[];
  /** 总评语。 */
  summary: string;
  /** 改进建议。 */
  improvements: string[];
}

/** 分析轨迹项（喂给评估 LLM 的输入）。 */
export interface AnalysisTraceItem {
  step: number;
  tool?: string;
  action?: string;
  finding?: string;
}

/** 评估器配置。 */
export interface QualityEvaluatorOptions {
  /** 评估用模型（便宜模型）。 */
  model?: LanguageModel;
  /** 兼容模式。 */
  compatMode?: boolean;
}

/** 系统提示词（引导 LLM 做结构化评分）。 */
function buildEvalSystemPrompt(): string {
  return `你是分析质量评估专家。对一次运营智能分析的结果做多维评分。

评分维度（每个 0-10 分）：
1. topic_consistency（主题一致性）：分析主题是否贯穿始终，有无漂移到其他主题
2. evidence_sufficiency（证据充分性）：核心结论是否有足够的工具调用支撑
3. root_cause_rationality（根因合理性）：根因是否符合 5Why 逻辑（诊断类适用，评估类给中性分）
4. recommendation_actionability（建议可执行性）：建议项是否带 actionTool + impact/executionScore
5. methodology_compliance（方法合规性）：是否遵循所选方法论的阶段顺序

只返回 JSON，不要其他内容。格式：
{
  "dimensions": [
    {"name":"主题一致性","score":8.5,"reason":"DMAIC 主题贯穿始终，未漂移"},
    ...
  ],
  "summary":"总体评价...",
  "improvements":["改进建议1","改进建议2"]
}`;
}

/** 用户提示词（含分析轨迹 + 最终结论）。 */
function buildEvalUserPrompt(
  intent: string,
  trace: AnalysisTraceItem[],
  finalText: string,
  methodologyTopic?: string,
): string {
  const traceText = trace.length > 0
    ? trace.map((t) => `${t.step}. ${t.action ?? ""}（工具：${t.tool ?? "-"}）→ ${t.finding ?? ""}`).join("\n")
    : "（无工具调用轨迹）";

  return `分析意图：${intent}
方法论：${methodologyTopic ?? "未明确"}

分析轨迹：
${traceText}

最终结论：
${finalText}

请评估本次分析的质量。`;
}

/** 解析 LLM 返回的 JSON（容错提取）。 */
function parseEvalResponse(raw: string): QualityAssessment | null {
  try {
    const parsed = JSON.parse(raw) as { dimensions?: unknown; summary?: string; improvements?: unknown };
    if (!Array.isArray(parsed.dimensions)) return null;
    const dims = parsed.dimensions as DimensionScore[];
    const valid = dims.filter((d) => typeof d.score === "number" && typeof d.name === "string");
    if (valid.length === 0) return null;
    const overall = valid.reduce((s, d) => s + d.score, 0) / valid.length;
    return {
      overall: Number(overall.toFixed(2)),
      dimensions: valid,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.filter((i) => typeof i === "string") : [],
    };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return parseEvalResponse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 执行质量评估（核心函数，可独立调用）。
 *
 * @returns QualityAssessment（评估失败时返回降级结构）
 */
export async function evaluateAnalysisQuality(
  intent: string,
  trace: AnalysisTraceItem[],
  finalText: string,
  opts: QualityEvaluatorOptions = {},
  methodologyTopic?: string,
): Promise<QualityAssessment> {
  // 无模型时返回降级评估（基于轨迹的启发式）
  if (!opts.model) {
    return heuristicEval(intent, trace, finalText);
  }

  try {
    const callArgs = opts.compatMode
      ? { messages: [{ role: "user" as const, content: `${buildEvalSystemPrompt()}\n\n---\n${buildEvalUserPrompt(intent, trace, finalText, methodologyTopic)}` }] }
      : { system: buildEvalSystemPrompt(), messages: [{ role: "user" as const, content: buildEvalUserPrompt(intent, trace, finalText, methodologyTopic) }] };

    const { text } = await generateText({
      model: opts.model,
      ...callArgs,
      temperature: 0.2,
      maxOutputTokens: 800,
    });

    const parsed = parseEvalResponse(text);
    return parsed ?? heuristicEval(intent, trace, finalText);
  } catch {
    return heuristicEval(intent, trace, finalText);
  }
}

/** 启发式降级评估（无 LLM 时用规则打分）。 */
function heuristicEval(intent: string, trace: AnalysisTraceItem[], finalText: string): QualityAssessment {
  const toolCount = trace.filter((t) => t.tool).length;
  const evidenceScore = Math.min(10, toolCount * 1.5);
  const hasRootCause = /根因|root cause/i.test(finalText);
  const rootCauseScore = hasRootCause ? 7 : 5;
  const hasRecommendation = /建议|recommend/i.test(finalText);
  const recScore = hasRecommendation ? 7 : 4;
  const consistencyScore = finalText.length > 100 ? 7 : 5;
  const complianceScore = toolCount >= 3 ? 7 : 5;
  const overall = Number(((evidenceScore + rootCauseScore + recScore + consistencyScore + complianceScore) / 5).toFixed(2));

  return {
    overall,
    dimensions: [
      { name: "主题一致性", score: consistencyScore, reason: "（启发式：基于结论长度推断）" },
      { name: "证据充分性", score: evidenceScore, reason: `（启发式：${toolCount} 个工具调用）` },
      { name: "根因合理性", score: rootCauseScore, reason: `（启发式：${hasRootCause ? "含根因" : "无根因"}）` },
      { name: "建议可执行性", score: recScore, reason: `（启发式：${hasRecommendation ? "含建议" : "无建议"}）` },
      { name: "方法合规性", score: complianceScore, reason: `（启发式：${toolCount >= 3 ? "取证充分" : "取证不足"}）` },
    ],
    summary: `启发式评估（无 LLM）：总评 ${overall}/10，${toolCount} 个工具调用。`,
    improvements: toolCount < 3 ? ["建议增加取证工具调用"] : [],
  };
}

/** 把 QualityAssessment 转为 ComponentLayout（用 score-card + reasoning-table 渲染）。 */
export function assessmentToLayout(assessment: QualityAssessment): ComponentLayout {
  const components: ComponentLayout["components"] = [];

  // 总分卡片
  components.push({
    name: "score-card",
    data: { value: assessment.overall, label: "总体评分", max: 10 },
    wrapper: { type: "section", title: "分析质量评估" },
  });

  // 各维度评分（用 KPI 网格展示）
  components.push({
    name: "kpi-grid",
    data: {
      cards: assessment.dimensions.map((d) => ({
        label: d.name,
        value: d.score.toFixed(1),
        target: d.reason.slice(0, 30),
        color: d.score >= 8 ? "#22c55e" : d.score >= 6 ? "#f59e0b" : "#ef4444",
      })),
    },
    wrapper: { type: "section", title: "各维度评分" },
  });

  // 改进建议
  if (assessment.improvements.length > 0) {
    components.push({
      name: "text-block",
      data: { text: `改进建议：\n${assessment.improvements.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}`, variant: "warn" },
      wrapper: { type: "section", title: "改进建议" },
    });
  }

  // 总评
  if (assessment.summary) {
    components.push({
      name: "text-block",
      data: { text: assessment.summary, variant: "muted" },
    });
  }

  return {
    reportType: "quality_assessment",
    title: "分析质量评估报告",
    components,
  };
}

/** 创建质量评估 skill。 */
export function createQualityEvaluatorSkill(opts: QualityEvaluatorOptions = {}) {
  return createSkill({
    name: "skill.quality_evaluate",
    description:
      "LLM 结果质量评估器：对一次分析的最终产出做多维评分（主题一致性/证据充分性/根因合理性/建议可执行性/方法合规性），输出评估报告。" +
      "分析完成后调用，产出质量评估报告 artifact（与原分析报告并列展示）。",
    whenToUse: {
      triggers: ["质量评估", "评估分析质量", "评估结果", "quality evaluate"],
      notFor: ["分析过程中调用（应在收尾后调用）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "本次分析的原始意图" },
        finalText: { type: "string", description: "本次分析的最终结论文本" },
        methodologyTopic: { type: "string", description: "本次分析使用的方法论 topic（如 dmaic / oee_diagnosis）" },
        trace: {
          type: "array",
          description: "分析轨迹（工具调用序列）",
          items: {
            type: "object",
            properties: {
              step: { type: "number" },
              tool: { type: "string" },
              action: { type: "string" },
              finding: { type: "string" },
            },
          },
        },
      },
      required: ["intent", "finalText"],
    },
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" }, confidence: { type: "string" } },
    },
    outputExample: { data: { html: "<!DOCTYPE html>...", _isHtmlReport: true }, confidence: "inferred" },

    async steps(input) {
      const { step, narrateSummary: skillSummary, selfCallId } = input;

      const step1 = await step<EvidenceEnvelope>("评估分析质量", async () => {
        const intent = String(input.intent ?? "");
        const finalText = String(input.finalText ?? "");
        const methodologyTopic = typeof input.methodologyTopic === "string" ? input.methodologyTopic : undefined;
        const trace = Array.isArray(input.trace) ? (input.trace as AnalysisTraceItem[]) : [];

        const assessment = await evaluateAnalysisQuality(intent, trace, finalText, opts, methodologyTopic);
        const layout = assessmentToLayout(assessment);
        const html = renderReport(layout);

        return wrapEvidence(
          {
            html,
            _isHtmlReport: true,
            assessment,
            reportType: "quality_assessment",
            confidence: assessment.overall / 10,
          },
          {
            freshness: "realtime",
            confidence: "inferred",
            system: "llm",
            provenance: "skill.quality_evaluate",
            caveat: "参考性评分（LLM 评估，非绝对标准）",
          },
        );
      });

      await skillSummary(
        `质量评估报告已生成：总评 ${(step1.data as { assessment: QualityAssessment }).assessment.overall}/10。` +
        `详见 [分析质量评估报告](#artifact:${selfCallId})。`,
      );

      return step1;
    },
  });
}
