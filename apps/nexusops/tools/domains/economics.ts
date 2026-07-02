/**
 * 经济性域工具集（应用层 —— T 内容）。
 *
 * 提供各产线的单位经济性参数（产值/成本/能耗单价），
 * 让成本汇总类分析（skill.cost_summary）脱离魔法数字，用真实财务主数据折算。
 * 数据源：ERP 财务模块（月度更新）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getUnitEconomics } from "../mock-data/scenarios.js";

export function registerEconomicsTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    createQueryTool({
      name: "economics.unit",
      description:
        "产线单位经济性参数（单件产值/成本/报废沉没/返工成本/能耗单价/人工费率）。用于成本折算与改善优先级的经济性评估。来源 ERP 财务主数据。",
      triggers: ["单位成本", "单件产值", "经济性", "成本折算", "改善优先级", "报废成本", "返工成本"],
      notFor: ["实时成本汇总（走 skill.cost_summary 实时组合）"],
      inputSchema: {
        type: "object",
        properties: {
          scenarioId: { type: "string", enum: ["normal", "anomaly", "crisis"] },
          line: { type: "string", enum: ["L01", "L02", "L03"] },
        },
      },
      getData: (ctx) => {
        const eco = getUnitEconomics(ctx);
        const margin = Number((eco.unitPrice - eco.unitCost).toFixed(2));
        const marginPct = Number(((margin / eco.unitPrice) * 100).toFixed(1));
        return {
          ...eco,
          unitMargin: margin,
          unitMarginPct: marginPct,
          dailyRevenueTarget: eco.unitPrice * eco.dailyTargetUnits,
        };
      },
      system: "ERP",
      provenance: (args) => `economics.unit?line=${args.line ?? "L01"}`,
    }),
  ];
}
