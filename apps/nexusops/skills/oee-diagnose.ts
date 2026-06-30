/**
 * skill.oee_diagnose：标准 OEE 诊断流（应用层 —— L 内容）。
 *
 * 沉淀自真实 ReAct 轨迹：OEE 低于目标时的系统性 5 步诊断。
 * 主 ReAct 循环可像调普通工具一样调此 skill，一键完成标准诊断取证。
 *
 * 步骤序列：
 *   1. 取实时 OEE + 损失分解
 *   2. 按最大损失项分流（可用/性能/质量）
 *   3. 取对应域的根因证据
 *   4. 交叉验证（5M1E 框架）
 *   5. 汇总成诊断结论
 *
 * 动态 DSL 写法：步骤间用具名变量传递，类型自动推导（无需 prior[N] as {...} 断言）。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { getOEE, getEquipment, getQuality, getProcess, ctxFromArgs, type ScenarioContext } from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

export function createOeeDiagnoseSkill() {
  return createSkill({
    name: "skill.oee_diagnose",
    description:
      "标准 OEE 诊断流：当某产线 OEE 低于目标时，一键完成 5 步诊断（取数→损失分解→根因取证→交叉验证→结论）。封装了已验证的最佳实践诊断轨迹。",
    whenToUse: {
      triggers: [
        "OEE 低需系统性诊断",
        "OEE 为什么低",
        "产线效率下滑的根因",
        "需要标准化 OEE 诊断",
      ],
      notFor: [
        "只看实时 OEE（走 oee.realtime）",
        "已知根因只需执行（直接调对应工具）",
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
      properties: {
        data: { type: "object" },
        confidence: { type: "string" },
      },
    },
    outputExample: {
      data: { diagnosis: "设备健康下降...", confidence: 0.8 },
      confidence: "measured",
    },

    async steps(input) {
      const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "normal";
      const line = typeof input.line === "string" ? input.line : undefined;
      const sctx: ScenarioContext = ctxFromArgs({ scenarioId, line });

      await skillNarrate(`我开始 OEE 诊断（场景：${scenarioId}${line ? `，产线 ${line}` : ""}）。`);

      // Step 1: 取实时 OEE + 损失分解
      const step1 = await step<{ oee: ReturnType<typeof getOEE>; biggestLoss: string }>(
        "取实时 OEE + 损失分解",
        async (ctx) => {
          await narrate(ctx, "正在取实时 OEE 与损失分解…");
          const oee = getOEE(sctx);
          await narrate(ctx, `OEE = ${(oee.oee * 100).toFixed(1)}%，最大损失项：${oee.availability < oee.performance && oee.availability < oee.quality ? "可用率" : oee.performance < oee.quality ? "性能" : "质量"}。`);
          return {
            oee,
            biggestLoss:
              oee.availability < oee.performance && oee.availability < oee.quality
                ? "availability"
                : oee.performance < oee.quality
                  ? "performance"
                  : "quality",
          };
        },
      );

      // Step 2: 按最大损失项分流取证
      const step2 = await step<{ lossType: string; evidence: Record<string, unknown> }>(
        "按最大损失项分流取证",
        async (ctx) => {
          const loss = step1.biggestLoss;
          const lossLabel = loss === "availability" ? "可用率" : loss === "performance" ? "性能" : "质量";
          await narrate(ctx, `按最大损失项（${lossLabel}）取证…`);
          let evidence: Record<string, unknown> = { lossType: loss };
          if (loss === "availability") {
            const eq = getEquipment(sctx);
            evidence = {
              ...evidence,
              downtimeEvents: eq.downtimeEvents,
              mtbfHours: eq.mtbfHours,
              healthScore: eq.healthScore,
            };
            await narrate(ctx, `停机事件 ${eq.downtimeEvents.length} 起，MTBF ${eq.mtbfHours} 小时，健康分 ${eq.healthScore.toFixed(2)}。`);
          } else if (loss === "performance") {
            const pr = getProcess(sctx);
            const deviations = Object.entries(pr.parameters).filter(
              ([, v]) => !(v as { inSpec: boolean }).inSpec,
            );
            evidence = {
              ...evidence,
              deviations,
              deviationScore: pr.deviationScore,
            };
            await narrate(ctx, `工艺偏离 ${pr.deviationScore.toFixed(2)}，超规格参数 ${deviations.length} 项。`);
          } else {
            const q = getQuality(sctx);
            evidence = {
              ...evidence,
              topDefects: q.topDefects,
              cpk: q.cpk,
              defectRate: q.defectRate,
            };
            await narrate(ctx, `不良率 ${(q.defectRate * 100).toFixed(1)}%，Cpk ${q.cpk.toFixed(2)}，主要缺陷 ${q.topDefects.length} 类。`);
          }
          return { lossType: loss, evidence };
        },
      );

      // Step 3: 交叉验证（5M1E 视角）
      const step3 = await step<{
        crossCheck: Record<string, unknown>;
        primaryEvidence: Record<string, unknown>;
      }>("交叉验证（5M1E 视角）", async (ctx) => {
        await narrate(ctx, "正在用 5M1E 视角交叉验证…");
        const eq = getEquipment(sctx);
        const pr = getProcess(sctx);
        const crossCheck = {
          equipmentHealth: eq.healthScore,
          processDeviation: pr.deviationScore,
          suspiciousDevice: eq.healthScore < 0.7,
          suspiciousProcess: pr.deviationScore > 0.3,
        };
        await narrate(
          ctx,
          `设备健康 ${eq.healthScore.toFixed(2)}${crossCheck.suspiciousDevice ? "（可疑）" : ""}，工艺偏离 ${pr.deviationScore.toFixed(2)}${crossCheck.suspiciousProcess ? "（可疑）" : ""}。`,
        );
        return {
          crossCheck,
          primaryEvidence: step2.evidence,
        };
      });

      // Step 4: 综合诊断结论
      const step4 = await step<{
        diagnosis: string;
        confidence: number;
        evidenceChain: Record<string, unknown>;
      }>("综合诊断结论", async (ctx) => {
        await narrate(ctx, "正在汇总诊断结论…");
        const cc = step3.crossCheck as {
          suspiciousDevice: boolean;
          suspiciousProcess: boolean;
        };
        const rootCause =
          cc.suspiciousDevice && cc.suspiciousProcess
            ? "设备健康下降 + 工艺参数漂移（强关联，建议先治设备）"
            : cc.suspiciousDevice
              ? "设备健康下降（振动/温度异常），传导至质量/性能"
              : cc.suspiciousProcess
                ? "工艺参数漂移（温度/压力偏离标准）"
                : "无单一明显根因，需进一步现场排查";
        return {
          diagnosis: rootCause,
          confidence: cc.suspiciousDevice || cc.suspiciousProcess ? 0.8 : 0.5,
          evidenceChain: step3.primaryEvidence,
        };
      });

      // Step 5: 包成诊断 EvidenceEnvelope
      const step5 = await step<ReturnType<typeof wrapEvidence>>(
        "包成诊断 EvidenceEnvelope",
        async (ctx) => {
          await narrate(ctx, "正在封装诊断结论…");
          return wrapEvidence(
            {
              scenarioId: sctx.scenarioId,
              line: sctx.line ?? "L01",
              currentOEE: step1.oee.oee,
              diagnosis: step4.diagnosis,
              confidence: step4.confidence,
              evidenceChain: step4.evidenceChain,
              stepsExecuted: 5,
            },
            {
              freshness: "realtime",
              confidence: step4.confidence > 0.7 ? "measured" : "estimated",
              system: "MES",
              provenance: "skill.oee_diagnose",
              caveat: "标准化诊断流，结论需现场工程师复核",
            },
          );
        },
      );

      await skillSummary(`OEE 诊断完成：${step4.diagnosis}（置信度 ${(step4.confidence * 100).toFixed(0)}%）。`);

      return step5;
    },
  });
}
