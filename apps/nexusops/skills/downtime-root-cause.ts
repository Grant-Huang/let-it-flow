/**
 * skill.downtime_root_cause：停机根因分析流（应用层 —— L 内容）。
 *
 * 沉淀自设备停机场景的标准 4 步根因分析。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import {
  getEquipment,
  getProcess,
  getMaterial,
  ctxFromArgs,
} from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import type { SkillStep } from "../../../src/agent/skill-bridge.js";

export function createDowntimeRootCauseSkill() {
  const steps: SkillStep[] = [
    {
      description: "取停机事件清单 + 设备状态",
      execute: async (_ctx, params) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const eq = getEquipment(sctx);
        return {
          step: 1,
          status: eq.status,
          totalDowntimeMinutes: eq.downtimeEvents.reduce((s, e) => s + e.minutes, 0),
          events: eq.downtimeEvents,
          topReason: eq.downtimeEvents[0]?.reason ?? "无停机",
        };
      },
    },
    {
      description: "查维护历史 + 备件",
      execute: async (_ctx, params, _prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const eq = getEquipment(sctx);
        return {
          step: 2,
          mtbfHours: eq.mtbfHours,
          mttrMinutes: eq.mttrMinutes,
          failureRisk30d: eq.failureRisk30d,
          healthScore: eq.healthScore,
          overdueMaintenance: eq.healthScore < 0.7,
        };
      },
    },
    {
      description: "交叉查工艺/物料排除外部因素",
      execute: async (_ctx, params, _prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const pr = getProcess(sctx);
        const m = getMaterial(sctx);
        return {
          step: 3,
          processDeviation: pr.deviationScore,
          materialShortageRisk: m.shortageRisk,
          externalCauseRuled:
            pr.deviationScore < 0.3 && m.shortageRisk < 0.3,
        };
      },
    },
    {
      description: "综合根因结论",
      execute: async (_ctx, params, prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const step1 = prior[0] as { topReason: string; totalDowntimeMinutes: number };
        const step2 = prior[1] as { healthScore: number; failureRisk30d: number };
        const step3 = prior[2] as { externalCauseRuled: boolean };

        let rootCause = step1.topReason;
        let category: string;
        if (step2.healthScore < 0.5) {
          category = "equipment_degradation";
          rootCause = `设备健康分 ${step2.healthScore.toFixed(2)} 严重偏低，主因：${step1.topReason}`;
        } else if (!step3.externalCauseRuled) {
          category = "external";
          rootCause = "停机可能由外部因素（物料/工艺）诱发，需进一步排查";
        } else {
          category = "sporadic";
          rootCause = `${step1.topReason}（偶发性，设备健康尚可）`;
        }

        return wrapEvidence(
          {
            scenarioId: sctx.scenarioId,
            line: sctx.line ?? "L01",
            rootCause,
            category,
            totalDowntimeMinutes: step1.totalDowntimeMinutes,
            confidence: category === "equipment_degradation" ? 0.85 : category === "sporadic" ? 0.6 : 0.5,
            recommendedNext:
              category === "equipment_degradation"
                ? "立即安排预防性维护（设备健康已恶化）"
                : category === "external"
                  ? "排查物料批次 + 工艺参数"
                  : "加强点检频次，监控复发",
          },
          {
            freshness: "realtime",
            confidence: category === "equipment_degradation" ? "measured" : "estimated",
            system: "MES",
            provenance: "skill.downtime_root_cause",
          },
        );
      },
    },
  ];

  return createSkill({
    name: "skill.downtime_root_cause",
    description:
      "标准停机根因分析流：当设备停机或可用率低时，4 步定位根因（停机事件→维护历史→排除外部→根因结论）。封装已验证的根因分析轨迹。",
    whenToUse: {
      triggers: [
        "设备停机原因",
        "停机根因",
        "可用率低为什么",
        "为什么频繁停机",
        "标准化停机分析",
      ],
      notFor: [
        "只看停机事件清单（走 equipment.downtime）",
        "OEE 综合诊断（走 skill.oee_diagnose）",
      ],
    },
    inputSchema: {
      type: "object",
      properties: {
        scenarioId: { type: "string", enum: ["normal", "anomaly", "crisis"] },
        line: { type: "string", enum: ["L01", "L02", "L03"] },
      },
    },
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" }, confidence: { type: "string" } },
    },
    outputExample: {
      data: { rootCause: "主轴轴承磨损", category: "equipment_degradation", confidence: 0.85 },
      confidence: "measured",
    },
    steps,
  });
}
