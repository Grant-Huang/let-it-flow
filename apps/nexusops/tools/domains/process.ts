/**
 * 工艺参数域工具集（应用层 —— T 内容）。
 *
 * 工艺参数实测 vs 标准、偏差分析、PFMEA、控制计划。
 * 数据源：PLM（工艺标准）+ MES（实测）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getProcess, getProcessFmea, lookupActionOverride, type ScenarioId } from "../mock-data/scenarios.js";

export function registerProcessTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 工艺参数实测
    createQueryTool({
      name: "process.parameters",
      description: "查指定产线的关键工艺参数实测值（温度/压力/速度等）。工艺漂移会直接导致质量/能耗问题。",
      triggers: ["工艺参数", "温度压力", "实际参数", "加工参数", "工艺实测"],
      notFor: ["参数标准（走 process.recipe）", "偏差分析（走 process.deviation）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        const actuals: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.parameters)) {
          const override = lookupActionOverride(ctx, k) as number | undefined;
          actuals[k] = override ?? v.actual;
        }
        return { parameters: actuals, inSpecCount: Object.values(p.parameters).filter((v) => v.inSpec).length };
      },
      system: "MES",
      provenance: (a) => `/mes/process/parameters?line=${(a.line as string) ?? "L01"}&realtime=true`,
    }),

    // 2. 参数偏差分析
    createQueryTool({
      name: "process.deviation",
      description: "查工艺参数相对标准的偏差。偏差大说明工艺失控，是质量问题的常见根因。",
      triggers: ["工艺偏差", "参数偏移", "偏离标准", "工艺漂移", "参数不对"],
      notFor: ["绝对实测值（走 process.parameters）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        const deviations = Object.entries(p.parameters).map(([k, v]) => ({
          param: k,
          actual: v.actual,
          standard: v.standard,
          delta: v.actual - v.standard,
          deltaPct: ((v.actual - v.standard) / v.standard) * 100,
          inSpec: v.inSpec,
        }));
        return {
          deviations,
          outOfSpecCount: deviations.filter((d) => !d.inSpec).length,
          deviationScore: p.deviationScore,
        };
      },
      system: "MES",
      provenance: (a) => `/mes/process/deviation?line=${(a.line as string) ?? "L01"}`,
    }),

    // 3. 工艺配方（标准）
    createQueryTool({
      name: "process.recipe",
      description: "查当前产品的工艺配方（标准参数 + 公差）。对照实测判断是否在规范内。",
      triggers: ["工艺配方", "标准参数", "工艺规范", "公差", "产品配方"],
      notFor: ["实测值（走 process.parameters）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        const recipe: Record<string, { standard: number; tolerance: number; unit: string }> = {};
        for (const [k, v] of Object.entries(p.parameters)) {
          recipe[k] = { standard: v.standard, tolerance: v.standard * 0.05, unit: v.unit };
        }
        return { recipe, productCode: "P-2026-A" };
      },
      system: "PLM",
      provenance: (a) => `/plm/process/recipe?line=${(a.line as string) ?? "L01"}&product=P-2026-A`,
      freshness: "historical",
    }),

    // 4. 标准 vs 实测对照
    createQueryTool({
      name: "process.standard_vs_actual",
      description: "标准 vs 实测并排对照表。直观看出哪个参数跑偏。",
      triggers: ["对照", "标准 vs 实测", "参数对比", "规范对照"],
      notFor: ["仅偏差（走 process.deviation）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        return {
          table: Object.entries(p.parameters).map(([k, v]) => ({
            param: k, standard: v.standard, actual: v.actual, unit: v.unit, inSpec: v.inSpec,
          })),
        };
      },
      system: "MES",
      provenance: (a) => `/mes/process/compare?line=${(a.line as string) ?? "L01"}`,
    }),

    // 5. 工艺能力
    createQueryTool({
      name: "process.capability",
      description: "查工艺过程能力（与 quality.cp_cpk 互补，此处更聚焦参数维度）。",
      triggers: ["工艺能力", "过程能力工艺", "工艺稳定性"],
      notFor: ["质量维度 Cp/Cpk（走 quality.cp_cpk）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        return {
          capability: p.capability,
          assessment: p.capability >= 1.33 ? "adequate" : p.capability >= 1.0 ? "marginal" : "inadequate",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/process/capability?line=${(a.line as string) ?? "L01"}`,
      freshness: "daily",
    }),

    // 6. 参数调整建议
    createQueryTool({
      name: "process.adjustment",
      description: "基于偏差给出参数调整建议（向标准回调多少）。注意：实际调整需人工确认。",
      triggers: ["参数调整", "调参数", "回调建议", "参数修正"],
      notFor: ["直接执行调整（无对应工具，需 HITL）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        const suggestions = Object.entries(p.parameters)
          .filter(([, v]) => !v.inSpec)
          .map(([k, v]) => ({
            param: k,
            current: v.actual,
            recommended: v.standard,
            delta: v.standard - v.actual,
          }));
        return {
          suggestions,
          requiresConfirmation: true,
          note: "参数调整影响产品质量，必须经工艺工程师确认后由操作员执行",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/process/adjustment_suggest?line=${(a.line as string) ?? "L01"}`,
      confidence: "inferred",
    }),

    // 7. PFMEA（AIAG-VDA 第五版，S/O/D + AP 行动优先级）
    createQueryTool({
      name: "process.fmea",
      description: "查工艺 PFMEA（过程失效模式与影响分析）。按 AIAG-VDA 第五版输出 S/O/D 三维评分 + AP 行动优先级（H/M/L 替代旧 RPN）+ 现行控制措施。用于风险量化与改善优先级排序。",
      triggers: ["PFMEA", "失效模式", "FMEA", "风险分析", "失效影响", "AP行动优先级", "SOD评分"],
      notFor: ["实时偏差（走 process.deviation）", "5Why 根因追问（走 quality.five_why）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        return getProcessFmea(ctx);
      },
      system: "PLM",
      provenance: (a) => `/plm/process/fmea?line=${(a.line as string) ?? "L01"}&standard=AIAG-VDA-v5`,
      freshness: "historical",
    }),

    // 8. 控制计划
    createQueryTool({
      name: "process.control_plan",
      description: "查工艺控制计划（控制项/方法/频次/反应计划）。判断控制是否覆盖关键参数。",
      triggers: ["控制计划", "控制项", "反应计划", "control plan"],
      notFor: ["PFMEA（走 process.fmea）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getProcess(ctx);
        return {
          controlItems: Object.keys(p.parameters).map((k) => ({
            characteristic: k,
            method: "自动化采集 + SPC",
            frequency: "连续",
            reactionPlan: k === "温度" ? "超 UCL 自动降温 + 通知工艺" : "超规范报警 + 停机检查",
          })),
        };
      },
      system: "PLM",
      provenance: (a) => `/plm/process/control_plan?line=${(a.line as string) ?? "L01"}`,
      freshness: "historical",
    }),
  ];
}

export type { ScenarioId };
