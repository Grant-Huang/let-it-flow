/**
 * 质量分析域工具集（应用层 —— T 内容）。
 *
 * 缺陷率、SPC、过程能力、5M1E 根因、首次合格率（FPY）。
 * 数据源：MOM（质量汇总）+ ERP（报废成本）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getQuality, type ScenarioId } from "../mock-data/scenarios.js";

const SYSTEM = "MOM";

export function registerQualityTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 缺陷率
    createQueryTool({
      name: "quality.defect_rate",
      description: "查指定产线的实时缺陷率。质量诊断的第一取证点。",
      triggers: ["缺陷率", "不良率", "质量水平", "废品率多少"],
      notFor: ["缺陷类型分布（走 quality.pareto）", "过程能力（走 quality.cp_cpk）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return { defectRate: q.defectRate, fpy: q.fpy, scrapRate: q.scrapRate, threshold: 0.03 };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/defect_rate?line=${(a.line as string) ?? "L01"}&today=true`,
    }),

    // 2. 缺陷帕累托
    createQueryTool({
      name: "quality.pareto",
      description: "查缺陷类型的帕累托分布（80/20）。识别「关键少数」缺陷，优先攻关。",
      triggers: ["缺陷分布", "帕累托", "主要缺陷", "缺陷类型排名", "80 20"],
      notFor: ["总缺陷率（走 quality.defect_rate）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return { topDefects: q.topDefects, paretoPrinciple: "前 20% 缺陷类型贡献约 80% 不良" };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/pareto?line=${(a.line as string) ?? "L01"}&window=7d`,
      freshness: "daily",
    }),

    // 3. SPC 统计过程控制
    createQueryTool({
      name: "quality.spc",
      description: "查关键尺寸的 SPC 控制图数据（CL/UCL/LCL + 最近样本）。判断过程是否受控。",
      triggers: ["SPC", "控制图", "过程受控", "UCL LCL", "均值极差图"],
      notFor: ["过程能力指数（走 quality.cp_cpk）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const outOfControl = q.cpk < 1.0;
        return {
          cl: 10.0, ucl: 10.15, lcl: 9.85,
          recentSamples: [10.02, 10.05, outOfControl ? 10.21 : 10.08, 10.04, outOfControl ? 10.18 : 10.06],
          outOfControl,
          ruleViolations: outOfControl ? ["连续 3 点超 UCL"] : [],
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/spc?line=${(a.line as string) ?? "L01"}&dim=critical`,
    }),

    // 4. 过程能力（Cp/Cpk）
    createQueryTool({
      name: "quality.cp_cpk",
      description: "查过程能力指数 Cp/Cpk。Cpk<1.33 说明能力不足，Cpk<1.0 说明严重不足。",
      triggers: ["过程能力", "Cp", "Cpk", "能力指数", "工序能力"],
      notFor: ["SPC 控制图（走 quality.spc）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return {
          cp: q.cp, cpk: q.cpk,
          assessment: q.cpk >= 1.33 ? "adequate" : q.cpk >= 1.0 ? "marginal" : "inadequate",
          usl: 10.2, lsl: 9.8, mean: 10.0, sigma: (10.2 - 9.8) / (6 * q.cp),
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/capability?line=${(a.line as string) ?? "L01"}`,
    }),

    // 5. 首次合格率 FPY
    createQueryTool({
      name: "quality.fpy",
      description: "查首次合格率（First Pass Yield）。FPY 低说明返工/报废多，隐形成本高。",
      triggers: ["首次合格率", "FPY", "一次通过率", "直通率"],
      notFor: ["缺陷率（走 quality.defect_rate）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return { fpy: q.fpy, target: 0.95, gap: 0.95 - q.fpy };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/fpy?line=${(a.line as string) ?? "L01"}&today=true`,
    }),

    // 6. 报废分析
    createQueryTool({
      name: "quality.scrap",
      description: "查报废数量 + 成本 + 报废原因。报废是最直接的质量损失。",
      triggers: ["报废", "报废成本", "废品", "报废原因"],
      notFor: ["缺陷率（走 quality.defect_rate）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return {
          scrapRate: q.scrapRate,
          scrapUnitsToday: Math.round(q.scrapRate * 1000),
          scrapCostCny: Math.round(q.scrapRate * 1000 * 45),
          topScrapReason: q.topDefects[0]?.type ?? "无",
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/quality/scrap?line=${(a.line as string) ?? "L01"}&today=true`,
    }),

    // 7. 返工分析
    createQueryTool({
      name: "quality.rework",
      description: "查返工数量 + 返工工时。返工占用产能但不出活。",
      triggers: ["返工", "返修", "返工工时", "返工成本"],
      notFor: ["报废（走 quality.scrap）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const reworkRate = (1 - q.fpy) - q.scrapRate;
        return {
          reworkRate,
          reworkUnitsToday: Math.round(reworkRate * 1000),
          reworkHoursToday: Math.round(reworkRate * 1000 * 0.3),
          reworkCostCny: Math.round(reworkRate * 1000 * 0.3 * 80),
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/rework?line=${(a.line as string) ?? "L01"}&today=true`,
    }),

    // 8. 检验记录
    createQueryTool({
      name: "quality.inspection",
      description: "查近期检验记录（首检/巡检/末检）。判断检验是否覆盖到位。",
      triggers: ["检验记录", "首检", "巡检", "末检", "检验频次"],
      notFor: ["缺陷统计（走 quality.defect_rate）"],
      inputSchema: { type: "object", properties: { shift: { type: "string", enum: ["A", "B", "C"] } } },
      getData: (ctx) => {
        const q = getQuality(ctx);
        return {
          firstPiece: { done: true, passed: q.fpy > 0.9 },
          routing: { intervals: "每 2 小时", lastAt: "2026-06-19T14:00:00Z", passed: q.fpy > 0.9 },
          lastPiece: { done: false, note: "班次未结束" },
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/inspection?line=${(a.line as string) ?? "L01"}`,
    }),

    // 9. 5M1E 根因框架
    createQueryTool({
      name: "quality.root_cause_5m1e",
      description: "按 5M1E（人/机/料/法/环/测）框架罗列当前可疑根因。质量问题的标准分析脚手架。",
      triggers: ["5M1E", "根因分析", "鱼骨图", "为什么不良", "质量根因"],
      notFor: ["具体缺陷类型（走 quality.pareto）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const suspect = q.cpk < 1.0;
        return {
          man: suspect ? ["新员工上岗未签 confirm"] : ["人员稳定"],
          machine: suspect ? ["设备健康分低（见 equipment.health）"] : ["设备正常"],
          material: suspect ? ["来料批次切换"] : ["来料稳定"],
          method: suspect ? ["工艺参数偏移（见 process.parameters）"] : ["工艺稳定"],
          environment: ["温湿度受控"],
          measurement: ["量具已校准"],
          topSuspect: suspect ? "machine + method" : "无显著异常",
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/5m1e?line=${(a.line as string) ?? "L01"}`,
      confidence: "inferred",
    }),
  ];
}

export type { ScenarioId };
