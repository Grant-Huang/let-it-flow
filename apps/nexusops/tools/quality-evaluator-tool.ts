/**
 * 质量评估工具（Phase 4.7）。
 *
 * 把 LLM 结果质量评估器暴露为 LLM 可直接调用的工具：nexus_quality_evaluate。
 * LLM 在分析完成后自主调用（或 prepare-step 检测到"分析结束"信号时触发）。
 *
 * 设计意图：与 skill.quality_evaluate 共用 evaluateAnalysisQuality 内核，
 * 本工具是无状态轻量壳，直接复用 quality-evaluator.ts 的评估内核 + 组件渲染，
 * 不重复实现评分逻辑（遵循"引用已有模块而非再生成"原则）。
 */
import type { FlowConnector } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../src/core/stream-events.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { randomUUID } from "node:crypto";
import {
  evaluateAnalysisQuality,
  assessmentToLayout,
  type QualityEvaluatorOptions,
  type AnalysisTraceItem,
} from "../skills/quality-evaluator.js";
import { renderReport } from "../skills/report-renderer.js";

/** 创建质量评估工具（nexus_quality_evaluate）。 */
export function createQualityEvaluatorTool(opts: QualityEvaluatorOptions = {}): FlowConnector {
  return {
    name: "nexus_quality_evaluate",
    tier: "core",
    description:
      "对一次分析的最终产出做多维质量评分（主题一致性/证据充分性/根因合理性/建议可执行性/方法合规性），" +
      "输出可视化评估报告（HTML）。分析完成后调用，用于自检分析质量。",
    uiLabel: "自检分析质量",
    whenToUse: {
      triggers: ["质量评估", "评估分析质量", "自检分析", "quality evaluate"],
      notFor: ["分析过程中调用（应在收尾后调用）", "取实时数据（走 domain.* 工具）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "本次分析的原始意图" },
        finalText: { type: "string", description: "本次分析的最终结论文本" },
        methodologyTopic: { type: "string", description: "本次分析使用的方法论 topic（如 dmaic / oee_diagnose / qs16949_audit）" },
        trace: {
          type: "array",
          description: "分析轨迹（工具调用序列），可选",
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

    async *execute(args) {
      const callId = randomUUID();
      const startedAt = Date.now();
      const params = args as {
        intent?: string;
        finalText?: string;
        methodologyTopic?: string;
        trace?: unknown;
      };

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({ id: callId, name: "nexus_quality_evaluate", args: params, risk: "safe", groupId: "nexus" }),
      } as ToolEvent;

      const intent = String(params.intent ?? "");
      const finalText = String(params.finalText ?? "");
      const methodologyTopic = typeof params.methodologyTopic === "string" ? params.methodologyTopic : undefined;
      const trace = Array.isArray(params.trace) ? (params.trace as AnalysisTraceItem[]) : [];

      const assessment = await evaluateAnalysisQuality(intent, trace, finalText, opts, methodologyTopic);
      const layout = assessmentToLayout(assessment);
      const html = renderReport(layout);

      const envelope = wrapEvidence(
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
          provenance: "nexus_quality_evaluate",
          caveat: "参考性评分（LLM 评估，非绝对标准）",
        },
      );

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(envelope), duration_ms: Date.now() - startedAt }),
      } as ToolEvent;

      return { output: envelope, summary: `质量评估完成：总评 ${assessment.overall}/10` };
    },
  };
}
