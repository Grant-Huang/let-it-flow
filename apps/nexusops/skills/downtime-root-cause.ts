/**
 * skill.downtime_root_cause：停机根因分析流（应用层 —— L 内容）。
 *
 * 沉淀自设备停机场景的标准 4 步根因分析。
 *
 * 动态 DSL 写法：步骤间用具名变量传递，类型自动推导。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import {
  getEquipment,
  getProcess,
  getMaterial,
  ctxFromArgs,
} from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

export function createDowntimeRootCauseSkill() {
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

    async steps(input) {
      const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "normal";
      const line = typeof input.line === "string" ? input.line : undefined;
      const sctx = ctxFromArgs({ scenarioId, line });

      await skillNarrate(`我开始停机根因分析（场景：${scenarioId}${line ? `，产线 ${line}` : ""}）。`);

      // Step 1: 取停机事件清单 + 设备状态
      const step1 = await step<{
        status: ReturnType<typeof getEquipment>["status"];
        totalDowntimeMinutes: number;
        events: ReturnType<typeof getEquipment>["downtimeEvents"];
        topReason: string;
      }>("取停机事件清单 + 设备状态", async (ctx) => {
        await narrate(ctx, "正在取停机事件清单与设备状态…");
        const eq = getEquipment(sctx);
        await narrate(ctx, `设备状态：${eq.status}，累计停机 ${eq.downtimeEvents.reduce((s, e) => s + e.minutes, 0)} 分钟。`);
        return {
          status: eq.status,
          totalDowntimeMinutes: eq.downtimeEvents.reduce((s, e) => s + e.minutes, 0),
          events: eq.downtimeEvents,
          topReason: eq.downtimeEvents[0]?.reason ?? "无停机",
        };
      });

      // Step 2: 查维护历史 + 备件
      const step2 = await step<{
        mtbfHours: number;
        mttrMinutes: number;
        failureRisk30d: number;
        healthScore: number;
        overdueMaintenance: boolean;
      }>("查维护历史 + 备件", async (ctx) => {
        await narrate(ctx, "正在查维护历史与备件状态…");
        const eq = getEquipment(sctx);
        const result = {
          mtbfHours: eq.mtbfHours,
          mttrMinutes: eq.mttrMinutes,
          failureRisk30d: eq.failureRisk30d,
          healthScore: eq.healthScore,
          overdueMaintenance: eq.healthScore < 0.7,
        };
        await narrate(
          ctx,
          `MTBF ${eq.mtbfHours} 小时，健康分 ${eq.healthScore.toFixed(2)}${result.overdueMaintenance ? "（已低于阈值）" : ""}。`,
        );
        return result;
      });

      // Step 3: 交叉查工艺/物料排除外部因素
      const step3 = await step<{
        processDeviation: number;
        materialShortageRisk: number;
        externalCauseRuled: boolean;
      }>("交叉查工艺/物料排除外部因素", async (ctx) => {
        await narrate(ctx, "正在交叉查工艺与物料，排除外部因素…");
        const pr = getProcess(sctx);
        const m = getMaterial(sctx);
        const result = {
          processDeviation: pr.deviationScore,
          materialShortageRisk: m.shortageRisk,
          externalCauseRuled: pr.deviationScore < 0.3 && m.shortageRisk < 0.3,
        };
        await narrate(
          ctx,
          `工艺偏离 ${pr.deviationScore.toFixed(2)}，物料风险 ${m.shortageRisk.toFixed(2)}，外部因素${result.externalCauseRuled ? "已排除" : "不能排除"}。`,
        );
        return result;
      });

      // Step 4: 综合根因结论（包成 EvidenceEnvelope）
      const step4 = await step<ReturnType<typeof wrapEvidence>>(
        "综合根因结论",
        async (ctx) => {
          await narrate(ctx, "正在汇总根因结论…");
          let rootCause = step1.topReason;
          let category: string;
          if (step2.healthScore < 0.5) {
            category = "equipment_degradation";
            rootCause = `设备健康分 ${step2.healthScore.toFixed(2)} 严重偏低，主因：${step1.topReason}`;
            await narrate(ctx, `设备健康分 ${step2.healthScore.toFixed(2)} < 0.5，判定为设备劣化型根因。`);
          } else if (!step3.externalCauseRuled) {
            category = "external";
            rootCause = "停机可能由外部因素（物料/工艺）诱发，需进一步排查";
            await narrate(ctx, "外部因素未能排除，判定为外部诱发型根因。");
          } else {
            category = "sporadic";
            rootCause = `${step1.topReason}（偶发性，设备健康尚可）`;
            await narrate(ctx, "设备健康尚可且外部因素已排除，判定为偶发型根因。");
          }

          return wrapEvidence(
            {
              scenarioId: sctx.scenarioId,
              line: sctx.line ?? "L01",
              rootCause,
              category,
              totalDowntimeMinutes: step1.totalDowntimeMinutes,
              confidence:
                category === "equipment_degradation"
                  ? 0.85
                  : category === "sporadic"
                    ? 0.6
                    : 0.5,
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
      );

      const rootCauseData = step4.data as { rootCause?: string; category?: string };
      await skillSummary(`根因分析完成：${rootCauseData.rootCause ?? "已定位"}。`);

      return step4;
    },
  });
}
