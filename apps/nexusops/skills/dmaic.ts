/**
 * skill.dmaic：DMAIC 改善项目管理框架（应用层 —— L 内容）。
 *
 * 替代原 domain 工具 lean.dmaic。原工具直取 6 个 accessor（跨域耦合），
 * 现改为 5 阶段 skill，每阶段按需 ctx.call Layer 1 工具。
 *
 * 步骤序列（按 DMAIC 五阶段）：
 *   D: ctx.call("oee.realtime") + ctx.call("quality.cp_cpk") + ctx.call("skill.cost_summary") → 定义
 *   M: ctx.call("quality.defect_rate") + ctx.call("quality.fpy") → 测量基线
 *   A: ctx.call("quality.five_why") + ctx.call("quality.fishbone") → 根因分析
 *   I: 组合改善行动（基于 M/A 数据）
 *   C: 组合控制计划
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

export function createDmaicSkill() {
  return createSkill({
    name: "skill.dmaic",
    description:
      "DMAIC 改善项目管理框架：按 Define/Measure/Analyze/Improve/Control 五阶段产出改善路线图。每阶段关联对应工具和数据，适用于 6Sigma 改善课题的端到端规划。输入当前问题的产线，自动组装五阶段行动方案。",
    whenToUse: {
      triggers: ["DMAIC", "6Sigma 项目", "改善项目", "六西格玛", "DMAIC 框架", "改善路线图"],
      notFor: ["七大浪费审计（走 skill.waste_audit）", "单一域诊断（走对应域工具）"],
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
      data: { projectTitle: "L01 产线改善项目", phases: [] },
      confidence: "inferred",
    },

    async steps(input) {
      const { step, narrateSummary: skillSummary, selfCallId } = input;
      const line = typeof input.line === "string" ? input.line : "L01";
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const baseParams = { line, scenarioId };

      // D 阶段：定义
      const definePhase = await step<{ oee: number; target: number; cpk: number; totalLossCost: number }>(
        "D 定义：取 OEE/Cpk/成本量化课题",
        async (ctx) => {
          const oeeEnv = await ctx.call<{ data: { oee: number; target: number } }>("oee.realtime", baseParams);
          const o = unpack<{ oee: number; target: number }>(oeeEnv);
          const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
          const c = unpack<{ cpk: number }>(cpEnv);
          const costEnv = await ctx.call<{ data: { totalLossCost: number } }>("skill.cost_summary", baseParams);
          const cost = unpack<{ totalLossCost: number }>(costEnv);
          return { oee: o.oee, target: o.target, cpk: c.cpk, totalLossCost: cost.totalLossCost };
        },
      );

      // M 阶段：测量
      const measurePhase = await step<{ defectRate: number; fpy: number; scrapRate: number; cpk: number; sigmaLt: number; dpmo: number }>(
        "M 测量：建立过程基线",
        async (ctx) => {
          const drEnv = await ctx.call<{ data: { defectRate: number; fpy: number; scrapRate: number } }>("quality.defect_rate", baseParams);
          const dr = unpack<{ defectRate: number; fpy: number; scrapRate: number }>(drEnv);
          const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
          const cp = unpack<{ cpk: number }>(cpEnv);
          const zSt = 3 * cp.cpk;
          const zLt = zSt - 1.5;
          const dpmo = Math.round(dr.defectRate * 1_000_000);
          return {
            defectRate: dr.defectRate,
            fpy: dr.fpy,
            scrapRate: dr.scrapRate,
            cpk: cp.cpk,
            sigmaLt: Number(zLt.toFixed(2)),
            dpmo,
          };
        },
      );

      // A 阶段：分析
      const analyzePhase = await step<{
        rootCause: string;
        mechanismPath: string;
        hasCausalChain: boolean;
        fishboneTopSuspect: string;
      }>("A 分析：根因分析", async (ctx) => {
        const fwEnv = await ctx.call<{ data: { chains: Array<{ rootCause: string; layers: string[] }> } }>("quality.five_why", baseParams);
        const fw = unpack<{ chains: Array<{ rootCause: string; layers: string[] }> }>(fwEnv);
        const fbEnv = await ctx.call<{ data: { topSuspect: string } }>("quality.fishbone", baseParams);
        const fb = unpack<{ topSuspect: string }>(fbEnv);
        if (fw.chains.length > 0) {
          const chain = fw.chains[0]!;
          return {
            rootCause: chain.rootCause,
            mechanismPath: chain.layers.join(" → "),
            hasCausalChain: true,
            fishboneTopSuspect: fb.topSuspect,
          };
        }
        return {
          rootCause: "待分析（normal 场景无已识别根因）",
          mechanismPath: "",
          hasCausalChain: false,
          fishboneTopSuspect: fb.topSuspect,
        };
      });

      // I 阶段：改善（基于 M/A 数据组合）
      const improvePhase = await step<{ proposedActions: Array<{ action: string; tool: string; priority: string }> }>(
        "I 改善：组合改善行动",
        async () => {
          const proposedActions: Array<{ action: string; tool: string; priority: string }> = [];
          if (analyzePhase.hasCausalChain) {
            proposedActions.push({
              action: `针对根因"${analyzePhase.rootCause}"实施对策`,
              tool: "nexus_advise",
              priority: "high",
            });
          }
          if (measurePhase.cpk < 1.0) {
            proposedActions.push({ action: "工艺参数回调至标准值", tool: "mcp.process.adjust_parameters", priority: "high" });
          }
          return { proposedActions };
        },
      );

      // C 阶段 + 组装（合并为最终输出）
      const stepFinal = await step<EvidenceEnvelope>("C 控制 + 组装 DMAIC 路线图", async () => {
        const zLt = measurePhase.sigmaLt;
        const reasoningChain = [
          {
            step: 1,
            action: "D 定义：量化课题",
            tool: "oee.realtime + quality.cp_cpk + skill.cost_summary",
            finding: `OEE=${(definePhase.oee * 100).toFixed(1)}%（目标 ${(definePhase.target * 100).toFixed(1)}%），Cpk=${definePhase.cpk.toFixed(2)}，日损失 ${definePhase.totalLossCost} 元`,
            inference: "课题成立：存在显著改善空间，进入测量",
          },
          {
            step: 2,
            action: "M 测量：建立基线",
            tool: "quality.defect_rate + quality.cp_cpk",
            finding: `不良率 ${(measurePhase.defectRate * 100).toFixed(1)}%，FPY ${(measurePhase.fpy * 100).toFixed(1)}%，DPMO=${measurePhase.dpmo}，长期 σ=${measurePhase.sigmaLt}`,
            inference: `基线 σ=${measurePhase.sigmaLt}（${measurePhase.sigmaLt < 3 ? "远低于" : "接近"}目标 4），进入分析`,
          },
          {
            step: 3,
            action: "A 分析：根因分析",
            tool: "quality.five_why + quality.fishbone",
            finding: analyzePhase.hasCausalChain
              ? `根因=${analyzePhase.rootCause}，机制=${analyzePhase.mechanismPath}`
              : "无已识别因果链（normal 场景）",
            inference: analyzePhase.hasCausalChain ? "根因已定位，进入改善" : "需补数据后分析",
          },
          {
            step: 4,
            action: "I 改善：组合对策",
            tool: "nexus_advise + mcp.*",
            finding: `${improvePhase.proposedActions.length} 项对策（${improvePhase.proposedActions.map((a) => a.action).join("；")}）`,
            inference: "对策已就绪，进入控制",
          },
          {
            step: 5,
            action: "C 控制：固化成果",
            tool: "quality.spc + process.control_plan",
            finding: `建立 SPC + 标准作业 + 审核，目标 Cpk=1.33、σ=4`,
            inference: "控制计划已就绪，项目可立项",
          },
        ];
        const diagnosis = `${line} DMAIC：当前 σ=${zLt}（目标 4），${analyzePhase.hasCausalChain ? `根因=${analyzePhase.rootCause}` : "需补数据定位根因"}`;
        return wrapEvidence(
          {
            line,
            scenarioId,
            diagnosis,
            projectTitle: `${line} 产线改善项目`,
            phases: [
              {
                phase: "D",
                name: "Define（定义）",
                objective: "明确改善课题的范围、目标、财务收益",
                problemStatement: analyzePhase.hasCausalChain
                  ? analyzePhase.rootCause
                  : `OEE=${(definePhase.oee * 100).toFixed(1)}%，Cpk=${definePhase.cpk.toFixed(2)}，存在改善空间`,
                goalStatement: `OEE 从 ${(definePhase.oee * 100).toFixed(1)}% 提升至 ${(definePhase.target * 100).toFixed(1)}%，Cpk 从 ${definePhase.cpk.toFixed(2)} 提升至 ≥1.33`,
                financialBenefit: `预计日节约 ${Math.round(definePhase.totalLossCost * 0.3)} 元（假设改善 30% 损失）`,
                tools: ["skill.cost_summary（量化损失）", "schedule.current（定义范围）"],
                status: "ready",
              },
              {
                phase: "M",
                name: "Measure（测量）",
                objective: "量化当前过程的基线表现",
                baselineMetrics: {
                  oee: definePhase.oee,
                  cpk: measurePhase.cpk,
                  fpy: measurePhase.fpy,
                  defectRate: measurePhase.defectRate,
                  scrapRate: measurePhase.scrapRate,
                  dpmo: measurePhase.dpmo,
                  longTermSigma: zLt,
                },
                tools: ["quality.sigma_level", "quality.dpmo", "quality.spc", "quality.cp_cpk"],
                status: "ready",
              },
              {
                phase: "A",
                name: "Analyze（分析）",
                objective: "识别根本原因，建立缺陷与输入变量的因果关系",
                rootCauseAnalysis: analyzePhase.hasCausalChain
                  ? { method: "5Why + 鱼骨图", rootCause: analyzePhase.rootCause, mechanismPath: analyzePhase.mechanismPath }
                  : { method: "待分析（normal 场景无已识别根因）", rootCause: "需收集更多数据后分析" },
                tools: ["quality.five_why", "quality.fishbone", "quality.pareto", "process.deviation"],
                status: analyzePhase.hasCausalChain ? "ready" : "blocked_by_data",
              },
              {
                phase: "I",
                name: "Improve（改善）",
                objective: "实施改善方案，验证效果",
                proposedActions: improvePhase.proposedActions,
                tools: ["nexus_advise", "mcp.* 动作工具（HITL 确认）"],
                status: "ready",
              },
              {
                phase: "C",
                name: "Control（控制）",
                objective: "建立监控体系，固化改善成果",
                controlPlan: {
                  spcMonitoring: "对关键尺寸建立 SPC 控制图（走 quality.spc）",
                  standardWork: "更新标准作业指导书 + 控制计划（走 process.control_plan）",
                  auditFrequency: "每周审核 Cpk 趋势 + 每月评审 OEE 是否达标",
                  reactionPlan: "Cpk <1.0 触发紧急复检 + 参数回调",
                },
                targetMetrics: { cpk: 1.33, oee: definePhase.target, fpy: 0.95, sigmaLevel: 4 },
                tools: ["quality.spc", "quality.cp_cpk", "process.control_plan", "oee.trend"],
                status: "ready",
              },
            ],
            reasoningChain,
            confidence: 0.75,
            overallAssessment: {
              currentSigmaLevel: zLt,
              targetSigmaLevel: 4,
              gapToTarget: Number(Math.max(0, 4 - zLt).toFixed(2)),
              estimatedProjectDuration: zLt < 2 ? "3-6 个月" : zLt < 3 ? "2-4 个月" : "1-3 个月",
              priority: zLt < 2 ? "critical" : zLt < 3 ? "high" : "medium",
            },
          },
          {
            freshness: "daily",
            confidence: "inferred",
            system: "MOM",
            provenance: `skill.dmaic?line=${line}`,
            caveat: "由 oee/quality/cost 工具实时组合",
          },
        );
      });

      await skillSummary(
        `推理完成（5 阶段 D-M-A-I-C）：${(stepFinal.data as { reasoningChain: Array<{ inference: string }> }).reasoningChain.map((s) => s.inference).join(" → ")}。\n` +
        `结论：${(stepFinal.data as { diagnosis: string }).diagnosis}。\n` +
        `详见 [DMAIC 改善路线图](#artifact:${selfCallId})。`,
      );

      return stepFinal;
    },
  });
}
