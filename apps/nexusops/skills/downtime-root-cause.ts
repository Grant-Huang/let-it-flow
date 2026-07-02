/**
 * skill.downtime_root_cause：停机根因分析流（应用层 —— L 内容）。
 *
 * 沉淀自设备停机场景的标准 4 步根因分析。
 *
 * 所有取数走 ctx.call（经 EvidenceEnvelope 协议 + actionStore 副作用），
 * 不再直取 accessor 函数。
 *
 * 动态 DSL 写法：步骤间用具名变量传递，类型自动推导。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

interface CausalChainShape {
  symptom: string;
  chains: Array<{ method: string; layers: string[]; rootCause: string }>;
  fishbone: {
    man: string[];
    machine: string[];
    material: string[];
    method: string[];
    environment: string[];
    measurement: string[];
  };
}

export function createDowntimeRootCauseSkill() {
  return createSkill({
    name: "skill.downtime_root_cause",
    description:
      "标准停机根因分析流：当设备停机或可用率低时，4 步定位根因（停机事件→维护历史→排除外部→根因结论）。封装已验证的根因分析轨迹。所有取数走 ctx.call。",
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
      const { step, narrate: skillNarrate, narrateSummary: skillSummary, selfCallId } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const line = typeof input.line === "string" ? input.line : "L01";
      const baseParams = { scenarioId, line };

      await skillNarrate(`我开始停机根因分析（场景：${scenarioId}，产线 ${line}）。`);

      // Step 1: 取停机事件清单 + 设备状态
      const step1 = await step<{
        status: string;
        totalDowntimeMinutes: number;
        events: Array<{ reason: string; minutes: number; at: string }>;
        topReason: string;
      }>("取停机事件清单 + 设备状态", async (ctx) => {
        await narrate(ctx, "正在取停机事件清单与设备状态…");
        const stEnv = await ctx.call<{ data: { status: string } }>("equipment.status", baseParams);
        const status = unpack<{ status: string }>(stEnv).status;
        const dtEnv = await ctx.call<{ data: { events: Array<{ reason: string; minutes: number; at: string }>; totalDowntimeMinutes: number } }>(
          "equipment.downtime",
          baseParams,
        );
        const dt = unpack<{ events: Array<{ reason: string; minutes: number; at: string }>; totalDowntimeMinutes: number }>(dtEnv);
        await narrate(ctx, `设备状态：${status}，累计停机 ${dt.totalDowntimeMinutes} 分钟。`);
        return {
          status,
          totalDowntimeMinutes: dt.totalDowntimeMinutes,
          events: dt.events,
          topReason: dt.events[0]?.reason ?? "无停机",
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
        const mtEnv = await ctx.call<{ data: { mtbfHours: number } }>("equipment.mtbf", baseParams);
        const mtbfHours = unpack<{ mtbfHours: number }>(mtEnv).mtbfHours;
        const mtrEnv = await ctx.call<{ data: { mttrMinutes: number } }>("equipment.mttr", baseParams);
        const mttrMinutes = unpack<{ mttrMinutes: number }>(mtrEnv).mttrMinutes;
        const hEnv = await ctx.call<{ data: { healthScore: number } }>("equipment.health", baseParams);
        const healthScore = unpack<{ healthScore: number }>(hEnv).healthScore;
        const fEnv = await ctx.call<{ data: { failureRisk30d: number } }>("equipment.failure_predict", baseParams);
        const failureRisk30d = unpack<{ failureRisk30d: number }>(fEnv).failureRisk30d;
        const overdueMaintenance = healthScore < 0.7;
        await narrate(
          ctx,
          `MTBF ${mtbfHours} 小时，健康分 ${healthScore.toFixed(2)}${overdueMaintenance ? "（已低于阈值）" : ""}。`,
        );
        return { mtbfHours, mttrMinutes, failureRisk30d, healthScore, overdueMaintenance };
      });

      // Step 3: 交叉查工艺/物料排除外部因素
      const step3 = await step<{
        processDeviation: number;
        materialShortageRisk: number;
        externalCauseRuled: boolean;
      }>("交叉查工艺/物料排除外部因素", async (ctx) => {
        await narrate(ctx, "正在交叉查工艺与物料，排除外部因素…");
        const prEnv = await ctx.call<{ data: { deviationScore: number } }>("process.deviation", baseParams);
        const deviationScore = unpack<{ deviationScore: number }>(prEnv).deviationScore;
        const mEnv = await ctx.call<{ data: { shortageRisk: number } }>("material.shortage", baseParams);
        const shortageRisk = unpack<{ shortageRisk: number }>(mEnv).shortageRisk;
        const externalCauseRuled = deviationScore < 0.3 && shortageRisk < 0.3;
        await narrate(
          ctx,
          `工艺偏离 ${deviationScore.toFixed(2)}，物料风险 ${shortageRisk.toFixed(2)}，外部因素${externalCauseRuled ? "已排除" : "不能排除"}。`,
        );
        return { processDeviation: deviationScore, materialShortageRisk: shortageRisk, externalCauseRuled };
      });

      // Step 3.5: 因果链取证（替代纯阈值判断）
      const step35 = await step<{
        causalChain: CausalChainShape;
        fishboneMachine: string[];
        fishboneMethod: string[];
        primaryRootCause: string | null;
        mechanismPath: string | null;
        causalConfidence: number;
        evidenceMapping: Array<{ fishboneItem: string; dataSource: string; value: string }>;
      }>("因果链取证（5M1E 数据驱动）", async (ctx) => {
        await narrate(ctx, "正在调 quality.five_why / quality.fishbone，与停机事件证据交叉验证…");
        const fwEnv = await ctx.call<{ data: { symptom: string; chains: Array<{ method: string; layers: string[]; rootCause: string }> } }>(
          "quality.five_why",
          baseParams,
        );
        const fw = unpack<{ symptom: string; chains: Array<{ method: string; layers: string[]; rootCause: string }> }>(fwEnv);
        const fbEnv = await ctx.call<{ data: { branches: Array<{ dimension: string; factors: string[] }> } }>("quality.fishbone", baseParams);
        const fb = unpack<{ branches: Array<{ dimension: string; factors: string[] }> }>(fbEnv);
        const fishbone = {
          man: fb.branches.find((b) => b.dimension.includes("Man"))?.factors ?? [],
          machine: fb.branches.find((b) => b.dimension.includes("Machine"))?.factors ?? [],
          material: fb.branches.find((b) => b.dimension.includes("Material"))?.factors ?? [],
          method: fb.branches.find((b) => b.dimension.includes("Method"))?.factors ?? [],
          environment: fb.branches.find((b) => b.dimension.includes("Environment"))?.factors ?? [],
          measurement: fb.branches.find((b) => b.dimension.includes("Measurement"))?.factors ?? [],
        };
        const cc: CausalChainShape = { symptom: fw.symptom, chains: fw.chains, fishbone };

        const fishboneMachine = cc.fishbone.machine.slice(0, 3);
        const fishboneMethod = cc.fishbone.method.slice(0, 2);

        const evidenceMapping: Array<{ fishboneItem: string; dataSource: string; value: string }> = [];
        if (fishboneMachine.length > 0 && step2.healthScore < 0.8) {
          evidenceMapping.push({
            fishboneItem: fishboneMachine[0] ?? "",
            dataSource: "equipment.health",
            value: `healthScore=${step2.healthScore.toFixed(2)}，failureRisk30d=${(step2.failureRisk30d * 100).toFixed(0)}%`,
          });
        }
        if (fishboneMethod.length > 0 && step3.processDeviation > 0.2) {
          evidenceMapping.push({
            fishboneItem: fishboneMethod[0] ?? "",
            dataSource: "process.deviation",
            value: `deviationScore=${step3.processDeviation.toFixed(2)}`,
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
        const overlapCount = evidenceMapping.length;
        const causalConfidence = cc.chains.length > 0 ? Math.min(0.5 + overlapCount * 0.13, 0.92) : 0;

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
            `当前场景无已识别因果链。设备健康 ${step2.healthScore.toFixed(2)}，鱼骨各维度无历史记录。`,
          );
        }

        return { causalChain: cc, fishboneMachine, fishboneMethod, primaryRootCause, mechanismPath, causalConfidence, evidenceMapping };
      });

      // Step 4: 综合根因结论（优先用因果链，降级才用阈值判断）
      const reasoningChain = [
        {
          step: 1,
          action: "取停机事件清单 + 设备状态",
          tool: "equipment.status + equipment.downtime",
          finding: `状态=${step1.status}，累计停机 ${step1.totalDowntimeMinutes}min，首要原因「${step1.topReason}」`,
          inference: "停机事件已取证，下一步查维护历史与设备健康",
        },
        {
          step: 2,
          action: "查维护历史 + 备件",
          tool: "equipment.mtbf + equipment.mttr + equipment.health + equipment.failure_predict",
          finding: `MTBF=${step2.mtbfHours}h，健康分=${step2.healthScore.toFixed(2)}，30天故障风险=${(step2.failureRisk30d * 100).toFixed(0)}%`,
          inference: step2.overdueMaintenance ? "设备健康低于阈值，疑设备退化，需进一步交叉验证" : "设备健康尚可",
        },
        {
          step: 3,
          action: "交叉查工艺/物料排除外部因素",
          tool: "process.deviation + material.shortage",
          finding: `工艺偏离=${step3.processDeviation.toFixed(2)}，物料风险=${step3.materialShortageRisk.toFixed(2)}`,
          inference: step3.externalCauseRuled ? "外部因素已排除，停机源于设备自身" : "外部因素未能排除，需进一步排查",
        },
        {
          step: 4,
          action: "因果链取证（5M1E 数据驱动）",
          tool: "quality.five_why + quality.fishbone",
          finding: step35.primaryRootCause
            ? `因果链命中：${step35.causalChain.chains.length} 条，主根因「${step35.primaryRootCause}」`
            : "无已识别因果链",
          inference: step35.primaryRootCause
            ? `根因=${step35.primaryRootCause}，与设备健康证据互证一致`
            : "降级为阈值推断",
        },
      ];
      const ruledOut: string[] = [];
      if (step3.externalCauseRuled) {
        ruledOut.push("外部物料短缺（shortageRisk<0.3）");
        ruledOut.push("工艺参数诱发（deviationScore<0.3）");
      }
      if (!step2.overdueMaintenance) ruledOut.push("设备健康严重退化（健康分≥0.7）");

      const step4 = await step<EvidenceEnvelope>(
        "综合根因结论",
        async (ctx) => {
          await narrate(ctx, "正在汇总根因结论…");
          let rootCause: string;
          let category: string;
          let confidence: number;
          let recommendedNext: string;

          if (step35.primaryRootCause) {
            category = "equipment_degradation";
            rootCause = step35.primaryRootCause;
            confidence = step35.causalConfidence;
            recommendedNext = "按因果链根因安排针对性维护（已有数据支撑，优先级高）";
            await narrate(
              ctx,
              `根因来自因果链：${rootCause}。机制路径：${step35.causalChain.chains[0]?.layers.at(-1) ?? ""}。置信度 ${(confidence * 100).toFixed(0)}%。`,
            );
          } else if (step2.healthScore < 0.5) {
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

          const diagnosis = `${line} 停机根因：${rootCause}（${category}）`;

          return wrapEvidence(
            {
              scenarioId,
              line,
              diagnosis,
              rootCause,
              category,
              totalDowntimeMinutes: step1.totalDowntimeMinutes,
              confidence,
              reasoningChain,
              ruledOut,
              mechanismExplained: step35.mechanismPath ?? "无因果链，需现场 5Why 验证",
              evidenceMapping: step35.evidenceMapping,
              auxiliaryFactors: [
                ...step35.fishboneMachine.slice(1),
                ...step35.causalChain.fishbone.man.slice(0, 1),
              ].filter(Boolean),
              causalChainsFound: step35.causalChain.chains.length,
              recommendedNext,
              dataSource: "ctx.call: equipment.* + process.deviation + material.shortage + quality.*",
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

      const rootCauseData = step4.data as { diagnosis?: string; rootCause?: string; category?: string; mechanismExplained?: string; confidence?: number };
      await skillSummary(
        `推理完成（${reasoningChain.length} 步）：${reasoningChain.map((s) => s.inference).join(" → ")}。\n` +
        `结论：${rootCauseData.diagnosis ?? rootCauseData.rootCause ?? "已定位"}（置信度 ${((rootCauseData.confidence ?? 0) * 100).toFixed(0)}%）。\n` +
        `详见 [完整诊断](#artifact:${selfCallId})。`,
      );

      return step4;
    },
  });
}
