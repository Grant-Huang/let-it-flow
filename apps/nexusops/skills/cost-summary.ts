/**
 * skill.cost_summary：综合损失成本汇总（应用层 —— L 内容）。
 *
 * 替代原 domain 工具 cost.summary。原工具直取预聚合的 COST 常量（Layer 2 混入 Layer 1），
 * 现改为通过 ctx.call 串联 Layer 1 工具（oee/energy/quality），实时组合成本。
 *
 * 步骤序列：
 *   1. ctx.call("oee.realtime") → 算 OEE 损失折算
 *   2. ctx.call("energy.cost") → 取能耗成本
 *   3. ctx.call("quality.defect_rate") + ctx.call("quality.scrap") → 算质量损失
 *   4. 组合为 { oeeLossCost, energyCost, qualityLossCost, totalLossCost }
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

export function createCostSummarySkill() {
  return createSkill({
    name: "skill.cost_summary",
    description:
      "综合损失成本汇总：从 oee/energy/quality 三域实时组合日损失成本（OEE 损失折算 + 能耗成本 + 质量损失）。用于改善优先级的经济性评估。封装了原 cost.summary 工具的逻辑，但改为通过 ctx.call 调 Layer 1 工具，确保经过 EvidenceEnvelope 协议与 actionStore 副作用。",
    whenToUse: {
      triggers: ["成本", "损失成本", "多少钱", "经济损失", "成本汇总", "改善优先级"],
      notFor: ["单类成本（能耗走 energy.cost，报废走 quality.scrap）"],
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
        oeeLossCost: 10800,
        energyCost: 2840,
        qualityLossCost: 2610,
        totalLossCost: 16250,
      },
      confidence: "measured",
    },

    async steps(input) {
      const { step, narrateSummary: skillSummary, selfCallId } = input;
      const line = typeof input.line === "string" ? input.line : "L01";
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const baseParams = { line, scenarioId };

      // Step 0: 取单位经济性（替代硬编码的 45 元/件、75 元/件魔法数字）
      const step0 = await step<{
        unitPrice: number; scrapCostPerUnit: number; reworkCostPerUnit: number; dailyTargetUnits: number;
      }>("取产线单位经济性参数（ERP 财务主数据）", async (ctx) => {
        const env = await ctx.call<{
          data: { unitPrice: number; scrapCostPerUnit: number; reworkCostPerUnit: number; dailyTargetUnits: number };
        }>("economics.unit", baseParams);
        const e = unpack<{ unitPrice: number; scrapCostPerUnit: number; reworkCostPerUnit: number; dailyTargetUnits: number }>(env);
        return {
          unitPrice: e.unitPrice,
          scrapCostPerUnit: e.scrapCostPerUnit,
          reworkCostPerUnit: e.reworkCostPerUnit,
          dailyTargetUnits: e.dailyTargetUnits,
        };
      });

      // Step 1: OEE 损失折算（用真实单位产值）
      const step1 = await step<{ oeeLossCost: number; outputLossUnits: number }>(
        "取 OEE 实时并折算损失成本",
        async (ctx) => {
          const env = await ctx.call<{ data: { oee: number; availability: number; performance: number; quality: number; target: number } }>(
            "oee.realtime",
            baseParams,
          );
          const o = unpack<{ oee: number; availability: number; performance: number; quality: number; target: number }>(env);
          // OEE 损失折算：损失产能 × 单位产值（来自 economics.unit）
          const outputLossUnits = Math.round((1 - o.oee) * step0.dailyTargetUnits);
          const oeeLossCost = Math.round(outputLossUnits * step0.unitPrice);
          return { oeeLossCost, outputLossUnits };
        },
      );

      // Step 2: 能耗成本
      const step2 = await step<{ energyCost: number }>("取能耗成本", async (ctx) => {
        const env = await ctx.call<{ data: { costTodayCny: number } }>("energy.cost", baseParams);
        const c = unpack<{ costTodayCny: number }>(env);
        return { energyCost: c.costTodayCny };
      });

      // Step 3: 质量损失成本（用真实报废/返工单件成本）
      const step3 = await step<{ qualityLossCost: number; scrapUnits: number }>("取质量损失并折算成本", async (ctx) => {
        const env = await ctx.call<{ data: { scrapRate: number } }>("quality.scrap", baseParams);
        const q = unpack<{ scrapRate: number }>(env);
        // 质量损失 = 报废件数 × 报废单件沉没成本 + 返工估算（报废率的 30% 视为可返工）
        const scrapUnits = Math.round(q.scrapRate * step0.dailyTargetUnits);
        const reworkUnits = Math.round(scrapUnits * 0.3);
        const qualityLossCost = Math.round(scrapUnits * step0.scrapCostPerUnit + reworkUnits * step0.reworkCostPerUnit);
        return { qualityLossCost, scrapUnits };
      });

      // Step 4: 组合汇总
      const step4 = await step<EvidenceEnvelope>(
        "组合为成本汇总信封",
        async () => {
          const totalLossCost = step1.oeeLossCost + step2.energyCost + step3.qualityLossCost;
          const reasoningChain = [
            {
              step: 1,
              action: "取产线单位经济性参数",
              tool: "economics.unit",
              finding: `单价=${step0.unitPrice}元，报废单件=${step0.scrapCostPerUnit}元，日目标产能=${step0.dailyTargetUnits}件`,
              inference: "财务主数据已就绪，作为三路折算基准",
            },
            {
              step: 2,
              action: "OEE 损失折算",
              tool: "oee.realtime",
              finding: `OEE 损失 ${step1.outputLossUnits} 件 → ${step1.oeeLossCost} 元`,
              inference: "OEE 损失为最大成本项" + (step1.oeeLossCost > step2.energyCost && step1.oeeLossCost > step3.qualityLossCost ? "（主导）" : ""),
            },
            {
              step: 3,
              action: "能耗成本",
              tool: "energy.cost",
              finding: `能耗成本 ${step2.energyCost} 元`,
              inference: "能耗为固定支出项",
            },
            {
              step: 4,
              action: "质量损失折算",
              tool: "quality.scrap",
              finding: `报废 ${step3.scrapUnits} 件 → ${step3.qualityLossCost} 元`,
              inference: "质量损失已计入报废+返工",
            },
          ];
          const diagnosis = `${line} 日损失成本 ${totalLossCost} 元（OEE ${step1.oeeLossCost} + 能耗 ${step2.energyCost} + 质量 ${step3.qualityLossCost}）`;
          return wrapEvidence(
            {
              line,
              diagnosis,
              productUnitPrice: step0.unitPrice,
              outputLossUnits: step1.outputLossUnits,
              oeeLossCost: step1.oeeLossCost,
              energyCost: step2.energyCost,
              qualityLossCost: step3.qualityLossCost,
              scrapUnits: step3.scrapUnits,
              totalLossCost,
              reasoningChain,
              confidence: 0.85,
            },
            {
              freshness: "daily",
              confidence: "measured",
              system: "MOM",
              provenance: `skill.cost_summary?line=${line}`,
              caveat: "由 economics.unit + oee.realtime + energy.cost + quality.scrap 实时组合（单价来自 ERP 财务主数据）",
            },
          );
        },
      );

      await skillSummary(
        `成本汇总完成：${(step4.data as { diagnosis: string }).diagnosis}。\n` +
        `详见 [完整成本报告](#artifact:${selfCallId})。`,
      );

      return step4;
    },
  });
}
