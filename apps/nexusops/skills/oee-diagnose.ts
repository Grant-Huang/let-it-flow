/**
 * skill.oee_diagnose：标准 OEE 诊断流（应用层 —— L 内容）。
 *
 * 沉淀自真实 ReAct 轨迹：OEE 低于目标时的系统性 5 步诊断。
 * 主 ReAct 循环可像调普通工具一样调此 skill，一键完成标准诊断取证。
 *
 * 步骤序列：
 *   1. 取实时 OEE + 损失分解
 *   2. 按最大损失项分流（可用/性能/质量）
 *   3. 因果链交叉验证（5M1E + getCausalChain 数据驱动）
 *   4. 汇总诊断结论（优先用 causal chain 根因，而非 LLM 先验）
 *   5. 包成诊断 EvidenceEnvelope
 *
 * 关键设计：Step 3 强制调用 getCausalChain()，确保根因结论来自数据而非推断。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import {
  getOEE,
  getEquipment,
  getQuality,
  getProcess,
  getCausalChain,
  ctxFromArgs,
  type ScenarioContext,
  type CausalChainData,
} from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

export function createOeeDiagnoseSkill() {
  return createSkill({
    name: "skill.oee_diagnose",
    description:
      "标准 OEE 诊断流：当某产线 OEE 低于目标时，一键完成 5 步诊断（取数→损失分解→因果链取证→交叉验证→结论）。封装了已验证的最佳实践诊断轨迹。根因结论来自 getCausalChain 数据，不依赖 LLM 先验推断。",
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
      data: {
        diagnosis: "自动润滑泵滤网堵塞（设备保养类）",
        mechanismExplained: "润滑泵堵塞→轴承磨损→主轴跳动→尺寸超差",
        confidence: 0.85,
        primaryRootCause: "自动润滑泵滤网堵塞",
        auxiliaryFactors: ["C班新员工换模技能不足", "温度偏高12℃"],
      },
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
          const biggestLoss =
            oee.availability < oee.performance && oee.availability < oee.quality
              ? "availability"
              : oee.performance < oee.quality
                ? "performance"
                : "quality";
          const lossLabel = biggestLoss === "availability" ? "可用率" : biggestLoss === "performance" ? "性能" : "质量";
          await narrate(ctx, `OEE = ${(oee.oee * 100).toFixed(1)}%，最大损失项：${lossLabel}（损失 ${((1 - (biggestLoss === "availability" ? oee.availability : biggestLoss === "performance" ? oee.performance : oee.quality)) * 100).toFixed(0)}pp）。`);
          return { oee, biggestLoss };
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
              mttrMinutes: eq.mttrMinutes,
              healthScore: eq.healthScore,
              failureRisk30d: eq.failureRisk30d,
            };
            await narrate(ctx, `停机事件 ${eq.downtimeEvents.length} 起，MTBF ${eq.mtbfHours}h（基线450h），健康分 ${eq.healthScore.toFixed(2)}，30天故障风险 ${(eq.failureRisk30d * 100).toFixed(0)}%。`);
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
            await narrate(ctx, `工艺偏离分 ${pr.deviationScore.toFixed(2)}，超规格参数 ${deviations.length} 项：${deviations.map(([k, v]) => `${k}=${(v as { actual: number }).actual}`).join(", ")}。`);
          } else {
            const q = getQuality(sctx);
            evidence = {
              ...evidence,
              topDefects: q.topDefects,
              cpk: q.cpk,
              defectRate: q.defectRate,
              fpy: q.fpy,
            };
            await narrate(ctx, `不良率 ${(q.defectRate * 100).toFixed(1)}%，Cpk ${q.cpk.toFixed(2)}，主要缺陷：${q.topDefects.map((d) => `${d.type}(${(d.pct * 100).toFixed(0)}%)`).join(" / ")}。`);
          }
          return { lossType: loss, evidence };
        },
      );

      // Step 3: 因果链交叉验证（数据驱动，替代纯阈值判断）
      const step3 = await step<{
        causalChain: CausalChainData;
        crossCheck: Record<string, unknown>;
        primaryEvidence: Record<string, unknown>;
        fishboneHighlights: string[];
      }>("因果链交叉验证（5M1E + causal chain）", async (ctx) => {
        await narrate(ctx, "正在提取因果链数据，与设备/工艺证据交叉验证…");
        const eq = getEquipment(sctx);
        const pr = getProcess(sctx);
        const q = getQuality(sctx);
        const cc = getCausalChain(sctx);

        // 把 fishbone 各分支与实测数据对照，找到有实测支撑的证据条目
        const fishboneHighlights: string[] = [];
        if (cc.fishbone.machine.length > 0 && eq.healthScore < 0.7) {
          fishboneHighlights.push(...cc.fishbone.machine.slice(0, 2));
        }
        if (cc.fishbone.method.length > 0 && pr.deviationScore > 0.3) {
          fishboneHighlights.push(...cc.fishbone.method.slice(0, 2));
        }
        if (cc.fishbone.man.length > 0) {
          fishboneHighlights.push(...cc.fishbone.man.slice(0, 1));
        }

        const crossCheck = {
          equipmentHealth: eq.healthScore,
          processDeviation: pr.deviationScore,
          defectRate: q.defectRate,
          suspiciousDevice: eq.healthScore < 0.7,
          suspiciousProcess: pr.deviationScore > 0.3,
          causalChainsFound: cc.chains.length,
          fishboneBranchesWithEvidence: Object.values(cc.fishbone).filter((b) => b.length > 0).length,
        };

        if (cc.chains.length > 0) {
          await narrate(
            ctx,
            `因果链：找到 ${cc.chains.length} 条 5Why 链，鱼骨图 ${crossCheck.fishboneBranchesWithEvidence}/6 个维度有证据。主要根因：${cc.chains[0]!.rootCause}。`,
          );
        } else {
          await narrate(
            ctx,
            `当前场景无已识别因果链（normal 工况）。设备健康 ${eq.healthScore.toFixed(2)}${crossCheck.suspiciousDevice ? "（可疑）" : "（正常）"}，工艺偏离 ${pr.deviationScore.toFixed(2)}${crossCheck.suspiciousProcess ? "（可疑）" : "（正常）"}。`,
          );
        }

        return {
          causalChain: cc,
          crossCheck,
          primaryEvidence: step2.evidence,
          fishboneHighlights,
        };
      });

      // Step 4: 综合诊断结论（优先用 causal chain 根因，降级才用阈值判断）
      const step4 = await step<{
        diagnosis: string;
        primaryRootCause: string;
        auxiliaryFactors: string[];
        mechanismExplained: string;
        confidence: number;
        evidenceChain: Record<string, unknown>;
      }>("综合诊断结论", async (ctx) => {
        await narrate(ctx, "正在汇总诊断结论…");
        const cc = step3.causalChain;
        const check = step3.crossCheck as {
          suspiciousDevice: boolean;
          suspiciousProcess: boolean;
          causalChainsFound: number;
        };

        let primaryRootCause: string;
        let mechanismExplained: string;
        let confidence: number;
        const auxiliaryFactors: string[] = [];

        if (cc.chains.length > 0) {
          // 有因果链：直接用 chains[0] 作为主根因，其他 fishbone 维度降为辅助因素
          const chain = cc.chains[0]!;
          primaryRootCause = chain.rootCause;
          mechanismExplained = chain.layers.join(" → ");
          confidence = 0.88;

          // 把其他 fishbone 分支中的因素作为辅助因素（man/material/environment）
          [...cc.fishbone.man, ...cc.fishbone.material].slice(0, 3).forEach((f) => {
            if (f.trim()) auxiliaryFactors.push(f.split("（")[0]!.trim());
          });

          await narrate(
            ctx,
            `主根因（来自 5Why 因果链）：${primaryRootCause}。机制路径：${chain.layers.at(-1) ?? ""}。辅助因素 ${auxiliaryFactors.length} 项。置信度 88%（因果链有实测支撑）。`,
          );
        } else if (check.suspiciousDevice && check.suspiciousProcess) {
          // 无因果链 + 双异常：提示需要进一步分析，不并列为"三个都是根因"
          primaryRootCause = "设备健康下降（主要嫌疑，需现场 5Why 确认）";
          mechanismExplained = "设备健康↓→工艺参数漂移→质量波动（推测链，需现场验证）";
          confidence = 0.55;
          auxiliaryFactors.push("工艺参数偏离（关联症状，待确认是根因还是并发症状）");
          await narrate(ctx, "设备和工艺双异常，但无因果链数据，暂以设备为主嫌疑，建议现场 5Why 后确认。");
        } else if (check.suspiciousDevice) {
          primaryRootCause = "设备健康下降（振动/温度异常）";
          mechanismExplained = "设备健康↓→停机频率↑→可用率↓";
          confidence = 0.65;
          await narrate(ctx, "设备健康下降为主嫌疑。");
        } else if (check.suspiciousProcess) {
          primaryRootCause = "工艺参数漂移（温度/压力偏离标准）";
          mechanismExplained = "工艺偏离→产品质量波动→不良率↑";
          confidence = 0.65;
          await narrate(ctx, "工艺参数漂移为主嫌疑。");
        } else {
          primaryRootCause = "无单一明显根因";
          mechanismExplained = "当前证据不足以确定根因，需现场补充排查";
          confidence = 0.4;
          await narrate(ctx, "当前证据不足以确定根因，建议现场补充排查。");
        }

        const diagnosis = auxiliaryFactors.length > 0
          ? `主根因：${primaryRootCause}；辅助因素：${auxiliaryFactors.join("、")}`
          : primaryRootCause;

        return {
          diagnosis,
          primaryRootCause,
          auxiliaryFactors,
          mechanismExplained,
          confidence,
          evidenceChain: {
            ...step3.primaryEvidence,
            fishboneHighlights: step3.fishboneHighlights,
            causalChainsFound: check.causalChainsFound,
          },
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
              oeeTarget: step1.oee.target,
              diagnosis: step4.diagnosis,
              primaryRootCause: step4.primaryRootCause,
              auxiliaryFactors: step4.auxiliaryFactors,
              mechanismExplained: step4.mechanismExplained,
              confidence: step4.confidence,
              evidenceChain: step4.evidenceChain,
              stepsExecuted: 5,
              dataSource: "getCausalChain + getEquipment + getQuality + getProcess",
            },
            {
              freshness: "realtime",
              confidence: step4.confidence > 0.7 ? "measured" : "estimated",
              system: "MES",
              provenance: "skill.oee_diagnose",
              caveat: "标准化诊断流，根因来自因果链数据；需现场工程师复核验证",
            },
          );
        },
      );

      await skillSummary(
        `OEE 诊断完成：主根因「${step4.primaryRootCause}」，机制路径：${step4.mechanismExplained}（置信度 ${(step4.confidence * 100).toFixed(0)}%）。`,
      );

      return step5;
    },
  });
}
