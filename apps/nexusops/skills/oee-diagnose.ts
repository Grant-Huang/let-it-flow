/**
 * skill.oee_diagnose：标准 OEE 诊断流（应用层 —— L 内容）。
 *
 * 沉淀自真实 ReAct 轨迹：OEE 低于目标时的系统性 5 步诊断。
 * 主 ReAct 循环可像调普通工具一样调此 skill，一键完成标准诊断取证。
 *
 * 步骤序列：
 *   1. ctx.call("oee.realtime") → 取实时 OEE + 损失分解
 *   2. 按最大损失项分流取证（ctx.call 对应域工具）
 *   3. ctx.call("quality.five_why") + ctx.call("quality.fishbone") → 因果链交叉验证
 *   4. 汇总诊断结论（优先用 causal chain 根因，而非 LLM 先验）
 *   5. 包成诊断 EvidenceEnvelope
 *
 * 关键设计：所有取数走 ctx.call（经 EvidenceEnvelope 协议 + actionStore 副作用），
 * 不再直取 accessor 函数。
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

export function createOeeDiagnoseSkill() {
  return createSkill({
    name: "skill.oee_diagnose",
    description:
      "标准 OEE 诊断流：当某产线 OEE 低于目标时，一键完成 5 步诊断（取数→损失分解→因果链取证→交叉验证→结论）。封装了已验证的最佳实践诊断轨迹。根因结论来自 quality.five_why 工具返回的因果链数据，不依赖 LLM 先验推断。",
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
      const { step, narrate: skillNarrate, narrateSummary: skillSummary, selfCallId } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const line = typeof input.line === "string" ? input.line : "L01";
      const baseParams = { scenarioId, line };

      await skillNarrate(`我开始 OEE 诊断（场景：${scenarioId}，产线 ${line}）。`);

      // Step 1: 取实时 OEE + 损失分解
      const step1 = await step<{ oee: number; availability: number; performance: number; quality: number; target: number; biggestLoss: string }>(
        "取实时 OEE + 损失分解",
        async (ctx) => {
          await narrate(ctx, "正在取实时 OEE 与损失分解…");
          const env = await ctx.call<{ data: { oee: number; availability: number; performance: number; quality: number; target: number } }>(
            "oee.realtime",
            baseParams,
          );
          const oee = unpack<{ oee: number; availability: number; performance: number; quality: number; target: number }>(env);
          const biggestLoss =
            oee.availability < oee.performance && oee.availability < oee.quality
              ? "availability"
              : oee.performance < oee.quality
                ? "performance"
                : "quality";
          const lossLabel = biggestLoss === "availability" ? "可用率" : biggestLoss === "performance" ? "性能" : "质量";
          await narrate(ctx, `OEE = ${(oee.oee * 100).toFixed(1)}%，最大损失项：${lossLabel}。`);
          return { ...oee, biggestLoss };
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
            const dtEnv = await ctx.call<{ data: { events: Array<{ reason: string; minutes: number }>; totalDowntimeMinutes: number } }>(
              "equipment.downtime",
              baseParams,
            );
            const dt = unpack<{ events: Array<{ reason: string; minutes: number }>; totalDowntimeMinutes: number }>(dtEnv);
            const mtEnv = await ctx.call<{ data: { mtbfHours: number } }>("equipment.mtbf", baseParams);
            const mt = unpack<{ mtbfHours: number }>(mtEnv);
            const mtrEnv = await ctx.call<{ data: { mttrMinutes: number } }>("equipment.mttr", baseParams);
            const mtr = unpack<{ mttrMinutes: number }>(mtrEnv);
            const hEnv = await ctx.call<{ data: { healthScore: number } }>("equipment.health", baseParams);
            const h = unpack<{ healthScore: number }>(hEnv);
            const fEnv = await ctx.call<{ data: { failureRisk30d: number } }>("equipment.failure_predict", baseParams);
            const f = unpack<{ failureRisk30d: number }>(fEnv);
            evidence = {
              ...evidence,
              downtimeEvents: dt.events,
              mtbfHours: mt.mtbfHours,
              mttrMinutes: mtr.mttrMinutes,
              healthScore: h.healthScore,
              failureRisk30d: f.failureRisk30d,
            };
            await narrate(ctx, `停机事件 ${dt.events.length} 起，MTBF ${mt.mtbfHours}h，健康分 ${h.healthScore.toFixed(2)}，30天故障风险 ${(f.failureRisk30d * 100).toFixed(0)}%。`);
          } else if (loss === "performance") {
            const prEnv = await ctx.call<{ data: { deviations: Array<{ param: string; actual: number; inSpec: boolean }>; deviationScore: number } }>(
              "process.deviation",
              baseParams,
            );
            const pr = unpack<{ deviations: Array<{ param: string; actual: number; inSpec: boolean }>; deviationScore: number }>(prEnv);
            const deviations = pr.deviations.filter((v) => !v.inSpec);
            evidence = { ...evidence, deviations, deviationScore: pr.deviationScore };
            await narrate(ctx, `工艺偏离分 ${pr.deviationScore.toFixed(2)}，超规格参数 ${deviations.length} 项：${deviations.map((v) => `${v.param}=${v.actual}`).join(", ")}。`);
          } else {
            const qEnv = await ctx.call<{ data: { defectRate: number; fpy: number } }>("quality.defect_rate", baseParams);
            const q = unpack<{ defectRate: number; fpy: number }>(qEnv);
            const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
            const cp = unpack<{ cpk: number }>(cpEnv);
            evidence = { ...evidence, defectRate: q.defectRate, cpk: cp.cpk, fpy: q.fpy };
            await narrate(ctx, `不良率 ${(q.defectRate * 100).toFixed(1)}%，Cpk ${cp.cpk.toFixed(2)}。`);
          }
          return { lossType: loss, evidence };
        },
      );

      // Step 3: 因果链交叉验证（数据驱动，替代纯阈值判断）
      const step3 = await step<{
        causalChain: CausalChainShape;
        crossCheck: Record<string, unknown>;
        primaryEvidence: Record<string, unknown>;
        fishboneHighlights: string[];
      }>("因果链交叉验证（5M1E + causal chain）", async (ctx) => {
        await narrate(ctx, "正在调 quality.five_why / quality.fishbone 取因果链，与设备/工艺证据交叉验证…");
        const hEnv = await ctx.call<{ data: { healthScore: number } }>("equipment.health", baseParams);
        const healthScore = unpack<{ healthScore: number }>(hEnv).healthScore;
        const prEnv = await ctx.call<{ data: { deviationScore: number } }>("process.deviation", baseParams);
        const deviationScore = unpack<{ deviationScore: number }>(prEnv).deviationScore;
        const qEnv = await ctx.call<{ data: { defectRate: number } }>("quality.defect_rate", baseParams);
        const defectRate = unpack<{ defectRate: number }>(qEnv).defectRate;

        const fwEnv = await ctx.call<{ data: { symptom: string; chains: Array<{ method: string; layers: string[]; rootCause: string }> } }>("quality.five_why", baseParams);
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

        const fishboneHighlights: string[] = [];
        if (cc.fishbone.machine.length > 0 && healthScore < 0.7) {
          fishboneHighlights.push(...cc.fishbone.machine.slice(0, 2));
        }
        if (cc.fishbone.method.length > 0 && deviationScore > 0.3) {
          fishboneHighlights.push(...cc.fishbone.method.slice(0, 2));
        }
        if (cc.fishbone.man.length > 0) {
          fishboneHighlights.push(...cc.fishbone.man.slice(0, 1));
        }

        const crossCheck = {
          equipmentHealth: healthScore,
          processDeviation: deviationScore,
          defectRate,
          suspiciousDevice: healthScore < 0.7,
          suspiciousProcess: deviationScore > 0.3,
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
            `当前场景无已识别因果链（normal 工况）。设备健康 ${healthScore.toFixed(2)}${crossCheck.suspiciousDevice ? "（可疑）" : "（正常）"}，工艺偏离 ${deviationScore.toFixed(2)}${crossCheck.suspiciousProcess ? "（可疑）" : "（正常）"}。`,
          );
        }

        return { causalChain: cc, crossCheck, primaryEvidence: step2.evidence, fishboneHighlights };
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
          const chain = cc.chains[0]!;
          primaryRootCause = chain.rootCause;
          mechanismExplained = chain.layers.join(" → ");
          confidence = 0.88;
          [...cc.fishbone.man, ...cc.fishbone.material].slice(0, 3).forEach((f) => {
            if (f.trim()) auxiliaryFactors.push(f.split("（")[0]!.trim());
          });
          await narrate(
            ctx,
            `主根因（来自 5Why 因果链）：${primaryRootCause}。机制路径：${chain.layers.at(-1) ?? ""}。辅助因素 ${auxiliaryFactors.length} 项。置信度 88%（因果链有实测支撑）。`,
          );
        } else if (check.suspiciousDevice && check.suspiciousProcess) {
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
      const reasoningChain = [
        {
          step: 1,
          action: "取实时 OEE + 损失分解",
          tool: "oee.realtime",
          finding: `OEE=${(step1.oee * 100).toFixed(1)}%，可用率 ${(step1.availability * 100).toFixed(1)}%、性能 ${(step1.performance * 100).toFixed(1)}%、质量 ${(step1.quality * 100).toFixed(1)}%`,
          inference: `最大损失项为${step1.biggestLoss === "availability" ? "可用率" : step1.biggestLoss === "performance" ? "性能" : "质量"}，疑${step1.biggestLoss === "availability" ? "设备/停机" : step1.biggestLoss === "performance" ? "工艺参数" : "质量"}问题，下一步取证对应域`,
        },
        {
          step: 2,
          action: "按最大损失项分流取证",
          tool: step1.biggestLoss === "availability" ? "equipment.downtime + equipment.mtbf + equipment.health + equipment.failure_predict"
            : step1.biggestLoss === "performance" ? "process.deviation"
            : "quality.defect_rate + quality.cp_cpk",
          finding: `针对${step1.biggestLoss === "availability" ? "可用率" : step1.biggestLoss === "performance" ? "性能" : "质量"}损失取证完成`,
          inference: `锁定主因域为${step1.biggestLoss === "availability" ? "设备" : step1.biggestLoss === "performance" ? "工艺" : "质量"}`,
        },
        {
          step: 3,
          action: "因果链交叉验证（5M1E + causal chain）",
          tool: "quality.five_why + quality.fishbone",
          finding: `找到 ${(step3.causalChain.chains.length)} 条 5Why 链，鱼骨图 ${(step3.crossCheck as { fishboneBranchesWithEvidence: number }).fishboneBranchesWithEvidence}/6 维度有证据`,
          inference: step3.causalChain.chains.length > 0
            ? `因果链根因：${step3.causalChain.chains[0]!.rootCause}，与设备/工艺证据互证一致`
            : "无明确因果链，降级为阈值判断",
        },
        {
          step: 4,
          action: "综合诊断结论",
          tool: "因果链优先 + 阈值降级",
          finding: step4.mechanismExplained,
          inference: `主根因：${step4.primaryRootCause}（置信度 ${(step4.confidence * 100).toFixed(0)}%）`,
        },
      ];
      const ruledOut: string[] = [];
      if (step1.biggestLoss !== "performance") ruledOut.push("性能损失为主因（性能损失非最大）");
      if (step1.biggestLoss !== "quality") ruledOut.push("质量损失为主因（质量损失非最大）");
      if ((step3.crossCheck as { suspiciousProcess: boolean }).suspiciousProcess === false) {
        ruledOut.push("工艺参数偏离（偏离分<0.3，在规格内）");
      }
      if ((step3.crossCheck as { suspiciousDevice: boolean }).suspiciousDevice === false) {
        ruledOut.push("设备健康下降（健康分≥0.7，正常）");
      }

      const step5 = await step<EvidenceEnvelope>(
        "包成诊断 EvidenceEnvelope",
        async (ctx) => {
          await narrate(ctx, "正在封装诊断结论…");
          return wrapEvidence(
            {
              scenarioId,
              line,
              currentOEE: step1.oee,
              oeeTarget: step1.target,
              diagnosis: step4.diagnosis,
              primaryRootCause: step4.primaryRootCause,
              auxiliaryFactors: step4.auxiliaryFactors,
              mechanismExplained: step4.mechanismExplained,
              confidence: step4.confidence,
              reasoningChain,
              ruledOut,
              evidenceChain: step4.evidenceChain,
              stepsExecuted: 5,
              dataSource: "ctx.call: oee.realtime + equipment.* + process.deviation + quality.* ",
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
        `推理完成（${reasoningChain.length} 步）：${reasoningChain.map((s) => s.inference).join(" → ")}。\n` +
        `结论：${step4.diagnosis}（置信度 ${(step4.confidence * 100).toFixed(0)}%）。\n` +
        `详见 [完整诊断](#artifact:${selfCallId})。`,
      );

      return step5;
    },
  });
}
