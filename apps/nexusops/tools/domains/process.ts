/**
 * 工艺参数域工具集（应用层 —— T 内容）。
 *
 * 工艺参数实测 vs 标准、偏差分析、PFMEA、控制计划。
 * 数据源：PLM（工艺标准）+ MES（实测）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getProcessParameters,
  getProcessAggregate,
  getProcessFmea,
  lookupActionOverride,
  type ScenarioId,
} from "../mock-data/scenarios.js";

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
        const params = getProcessParameters(ctx);
        const actuals: Record<string, number> = {};
        for (const [k, v] of Object.entries(params.parameters)) {
          const override = lookupActionOverride(ctx, k) as number | undefined;
          actuals[k] = override ?? v.actual;
        }
        return { parameters: actuals, inSpecCount: Object.values(params.parameters).filter((v) => v.inSpec).length };
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
        const params = getProcessParameters(ctx);
        const agg = getProcessAggregate(ctx);
        const deviations = Object.entries(params.parameters).map(([k, v]) => ({
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
          deviationScore: agg.deviationScore,
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
        const params = getProcessParameters(ctx);
        const recipe: Record<string, { standard: number; tolerance: number; unit: string }> = {};
        for (const [k, v] of Object.entries(params.parameters)) {
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
        const params = getProcessParameters(ctx);
        return {
          table: Object.entries(params.parameters).map(([k, v]) => ({
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
        const agg = getProcessAggregate(ctx);
        return {
          capability: agg.capability,
          assessment: agg.capability >= 1.33 ? "adequate" : agg.capability >= 1.0 ? "marginal" : "inadequate",
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
        const params = getProcessParameters(ctx);
        const suggestions = Object.entries(params.parameters)
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
        const params = getProcessParameters(ctx);
        return {
          controlItems: Object.keys(params.parameters).map((k) => ({
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

    // 9. 工艺偏差→质量影响映射（物理机制链，补缺 197°C→尺寸超差 的推理闭环）
    createQueryTool({
      name: "process.quality_impact",
      description:
        "对每个超规格工艺参数，返回完整的「偏差量→物理机制→缺陷类型」映射。用于闭合工艺偏差与质量缺陷之间的推理链（如温度+12℃→材料过热→缩水→尺寸偏小）。机制映射基于注塑工艺硬编码规则，不依赖 LLM 推断。",
      triggers: [
        "工艺参数影响质量",
        "温度偏高导致什么",
        "参数偏差怎么影响产品",
        "偏差机制",
        "工艺质量关系",
      ],
      notFor: ["只看参数值（走 process.parameters）", "质量缺陷统计（走 quality.defects）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const params = getProcessParameters(ctx);
        const outOfSpec = Object.entries(params.parameters).filter(([, v]) => !v.inSpec);

        // 注塑工艺参数→机制→缺陷 硬编码规则库
        const mechanismRules: Record<
          string,
          { direction: "high" | "low" | "any"; mechanism: string; qualityEffects: string[] }[]
        > = {
          温度: [
            {
              direction: "high",
              mechanism: "熔体过热 → 材料流动性过高 → 过度充填/收缩率异常",
              qualityEffects: ["表面气泡", "缩水", "尺寸偏小"],
            },
            {
              direction: "low",
              mechanism: "熔体温度不足 → 流动性差 → 充填不完整",
              qualityEffects: ["短射", "表面粗糙", "熔接线"],
            },
          ],
          压力: [
            {
              direction: "high",
              mechanism: "充填压力过大 → 过保压 → 材料压缩回弹",
              qualityEffects: ["飞边", "尺寸偏大", "锁模力不足风险"],
            },
            {
              direction: "low",
              mechanism: "保压不足 → 型腔补缩失败",
              qualityEffects: ["缩水", "尺寸偏小", "内部气孔"],
            },
          ],
          速度: [
            {
              direction: "low",
              mechanism: "注射速度过低 → 充填时间长 → 前锋料提前冷却",
              qualityEffects: ["短射", "流痕", "表面粗糙"],
            },
            {
              direction: "high",
              mechanism: "注射速度过高 → 剪切热过大 → 材料降解",
              qualityEffects: ["变色", "脆性增加", "表面烧焦"],
            },
          ],
        };

        const impacts = outOfSpec.map(([paramName, v]) => {
          const delta = v.actual - v.standard;
          const deltaPct = ((delta / v.standard) * 100).toFixed(1);
          const direction = delta > 0 ? "high" : "low";
          const rules = mechanismRules[paramName] ?? [];
          const matched = rules.find((r) => r.direction === direction || r.direction === "any");
          return {
            param: paramName,
            actual: v.actual,
            standard: v.standard,
            unit: paramName === "温度" ? "℃" : paramName === "压力" ? "MPa" : paramName === "速度" ? "mm/s" : "",
            deviation: `${delta > 0 ? "+" : ""}${delta.toFixed(1)} (${delta > 0 ? "+" : ""}${deltaPct}%)`,
            mechanism: matched?.mechanism ?? "偏差机制待确认（需查工艺 PFMEA）",
            qualityEffects: matched?.qualityEffects ?? [],
            evidenceRef: `PROCESS.${ctx.line ?? "L01"}.parameters.${paramName}`,
          };
        });

        return {
          outOfSpecCount: outOfSpec.length,
          impacts,
          summary:
            impacts.length > 0
              ? impacts.map((i) => `${i.param}${i.deviation} → ${i.mechanism.split("→").at(-1)?.trim() ?? ""} → ${i.qualityEffects.join("/")} `).join("；")
              : "当前所有工艺参数均在规格内，无质量影响风险",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/process/quality_impact?line=${(a.line as string) ?? "L01"}&mode=mechanism`,
    }),
  ];
}

export type { ScenarioId };
