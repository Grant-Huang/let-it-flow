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
  getCausalChain,
  ctxFromArgs,
  type CausalChainData,
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

      // Step 3.5: 因果链取证（替代纯阈值判断）
      const step35 = await step<{
        causalChain: CausalChainData;
        fishboneMachine: string[];
        fishboneMethod: string[];
        primaryRootCause: string | null;
        mechanismPath: string | null;
        causalConfidence: number;
        evidenceMapping: Array<{ fishboneItem: string; dataSource: string; value: string }>;
      }>("因果链取证（5M1E 数据驱动）", async (ctx) => {
        await narrate(ctx, "正在提取因果链数据，与停机事件证据交叉验证…");
        const cc = getCausalChain(sctx);
        const eq = getEquipment(sctx);
        const pr = getProcess(sctx);

        const fishboneMachine = cc.fishbone.machine.slice(0, 3);
        const fishboneMethod = cc.fishbone.method.slice(0, 2);

        // 构建证据映射：fishbone 条目 ↔ 实测数据
        const evidenceMapping: Array<{ fishboneItem: string; dataSource: string; value: string }> = [];
        if (fishboneMachine.length > 0 && eq.healthScore < 0.8) {
          evidenceMapping.push({
            fishboneItem: fishboneMachine[0] ?? "",
            dataSource: "equipment.health",
            value: `healthScore=${eq.healthScore.toFixed(2)}，failureRisk30d=${(eq.failureRisk30d * 100).toFixed(0)}%`,
          });
        }
        if (fishboneMethod.length > 0 && pr.deviationScore > 0.2) {
          evidenceMapping.push({
            fishboneItem: fishboneMethod[0] ?? "",
            dataSource: "process.deviation",
            value: `deviationScore=${pr.deviationScore.toFixed(2)}`,
          });
        }
        if (cc.fishbone.man.length > 0) {
          evidenceMapping.push({
            fishboneItem: cc.fishbone.man[0] ?? "",
            dataSource: "operator_log",
            value: "（人员因素，需现场确认）",
          });
        }

        let primaryRootCause: string | null = null;
        let mechanismPath: string | null = null;
        // 置信度依据因果链 overlap 数量（而非单一 health 阈值）
        const overlapCount = evidenceMapping.length;
        const causalConfidence = cc.chains.length > 0
          ? Math.min(0.5 + overlapCount * 0.13, 0.92)
          : 0;

        if (cc.chains.length > 0) {
          const chain = cc.chains[0]!;
          primaryRootCause = chain.rootCause;
          mechanismPath = chain.layers.join(" → ");
          await narrate(
            ctx,
            `因果链命中：${cc.chains.length} 条 5Why 链，鱼骨 ${Object.values(cc.fishbone).filter((b) => b.length > 0).length}/6 维度有证据。` +
            `主根因：${primaryRootCause}（overlap ${overlapCount} 项，置信度 ${(causalConfidence * 100).toFixed(0)}%）。`,
          );
        } else {
          await narrate(
            ctx,
            `当前场景无已识别因果链。设备健康 ${eq.healthScore.toFixed(2)}，鱼骨各维度无历史记录。`,
          );
        }

        return { causalChain: cc, fishboneMachine, fishboneMethod, primaryRootCause, mechanismPath, causalConfidence, evidenceMapping };
      });

      // Step 4: 综合根因结论（优先用因果链，降级才用阈值判断）
      const step4 = await step<ReturnType<typeof wrapEvidence>>(
        "综合根因结论",
        async (ctx) => {
          await narrate(ctx, "正在汇总根因结论…");
          let rootCause: string;
          let category: string;
          let confidence: number;
          let recommendedNext: string;

          if (step35.primaryRootCause) {
            // 有因果链：直接用 chains[0].rootCause 作为根因
            category = "equipment_degradation";
            rootCause = step35.primaryRootCause;
            confidence = step35.causalConfidence;
            recommendedNext = "按因果链根因安排针对性维护（已有数据支撑，优先级高）";
            await narrate(
              ctx,
              `根因来自因果链：${rootCause}。机制路径：${step35.causalChain.chains[0]?.layers.at(-1) ?? ""}。置信度 ${(confidence * 100).toFixed(0)}%。`,
            );
          } else if (step2.healthScore < 0.5) {
            // 无因果链 + 健康分极低：设备劣化型（阈值降级）
            category = "equipment_degradation";
            rootCause = `设备健康分 ${step2.healthScore.toFixed(2)} 严重偏低，主因：${step1.topReason}（需现场 5Why 确认）`;
            confidence = 0.65;
            recommendedNext = "立即安排预防性维护，同时现场 5Why 确认根因";
            await narrate(ctx, `设备健康分 ${step2.healthScore.toFixed(2)} < 0.5，降级为阈值判断，建议现场 5Why 确认。`);
          } else if (!step3.externalCauseRuled) {
            category = "external";
            rootCause = "停机可能由外部因素（物料/工艺）诱发，需进一步排查";
            confidence = 0.45;
            recommendedNext = "排查物料批次 + 工艺参数";
            await narrate(ctx, "外部因素未能排除，判定为外部诱发型根因（无因果链支撑，置信度低）。");
          } else {
            category = "sporadic";
            rootCause = `${step1.topReason}（偶发性，设备健康尚可）`;
            confidence = 0.5;
            recommendedNext = "加强点检频次，监控复发";
            await narrate(ctx, "设备健康尚可且外部因素已排除，判定为偶发型根因。");
          }

          return wrapEvidence(
            {
              scenarioId: sctx.scenarioId,
              line: sctx.line ?? "L01",
              rootCause,
              category,
              totalDowntimeMinutes: step1.totalDowntimeMinutes,
              confidence,
              mechanismExplained: step35.mechanismPath ?? "无因果链，需现场 5Why 验证",
              evidenceMapping: step35.evidenceMapping,
              auxiliaryFactors: [
                ...step35.fishboneMachine.slice(1),
                ...step35.causalChain.fishbone.man.slice(0, 1),
              ].filter(Boolean),
              causalChainsFound: step35.causalChain.chains.length,
              recommendedNext,
              dataSource: "getCausalChain + getEquipment + getProcess + getMaterial",
            },
            {
              freshness: "realtime",
              confidence: confidence > 0.7 ? "measured" : "estimated",
              system: "MES",
              provenance: "skill.downtime_root_cause",
              caveat: step35.primaryRootCause
                ? "根因来自因果链数据，需现场工程师复核"
                : "无因果链数据，为阈值推断，建议现场 5Why 确认",
            },
          );
        },
      );

      const rootCauseData = step4.data as { rootCause?: string; category?: string; mechanismExplained?: string; confidence?: number };
      await skillSummary(
        `停机根因分析完成：${rootCauseData.rootCause ?? "已定位"}。` +
        (rootCauseData.mechanismExplained && rootCauseData.mechanismExplained !== "无因果链，需现场 5Why 验证"
          ? `机制路径：${rootCauseData.mechanismExplained}。`
          : "") +
        `置信度 ${((rootCauseData.confidence ?? 0) * 100).toFixed(0)}%。`,
      );

      return step4;
    },
  });
}
