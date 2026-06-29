/**
 * 质量分析域工具集（应用层 —— T 内容）。
 *
 * 缺陷率、SPC、过程能力、5M1E 根因、首次合格率（FPY）。
 * 数据源：MOM（质量汇总）+ ERP（报废成本）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getQuality,
  getCausalChain,
  lookupActionOverride,
  type ScenarioContext,
  type ScenarioId,
} from "../mock-data/scenarios.js";

const SYSTEM = "MOM";

/**
 * 应用动作副作用覆盖到质量数据。
 *
 * 闭环逻辑：执行 mcp.qms.quarantine / scrap_batch / rework_order 后，
 * actionStore 写入 sideEffects；读取侧消费之，使"执行→复检"反映变化。
 *
 * - quarantined：隔离批冻结，可疑品不再计入当期产出 → 缺陷率口径调整
 * - scrapped：报废已处置，scrapQty 折算后更新报废率/缺陷率/质量率
 * - reworkScheduled：返工已排程，返工件从"在制不良"转为"已安排"，缺陷率下降、FPY 回升
 */
function applyQualityOverrides(ctx: ScenarioContext, base: ReturnType<typeof getQuality>) {
  const quarantined = lookupActionOverride(ctx, "quality.quarantined") === true;
  const scrapped = lookupActionOverride(ctx, "quality.scrapped") === true;
  const scrapQty = lookupActionOverride(ctx, "quality.scrapQty") as number | undefined;
  const reworkScheduled = lookupActionOverride(ctx, "quality.reworkScheduled") === true;

  // 无任何覆盖，原样返回（最常见路径，零开销）
  if (!quarantined && !scrapped && !reworkScheduled) return base;

  // 已处置的报废量折算（假设日产出基准 1000 件）
  const baseOutput = 1000;
  const scrapDelta = scrapped && scrapQty ? Math.min(scrapQty / baseOutput, base.scrapRate) : 0;
  // 隔离后可疑缺陷不再计入当期缺陷率（待复检）
  const quarantineReduction = quarantined ? base.defectRate * 0.4 : 0;
  // 返工排程后，返工相关不良从"在制缺陷"转为"已处理"
  const reworkReduction = reworkScheduled ? base.defectRate * 0.3 : 0;

  const newDefectRate = Math.max(0, base.defectRate - scrapDelta - quarantineReduction - reworkReduction);
  const newScrapRate = Math.max(0, base.scrapRate - scrapDelta);
  // FPY 回升：报废和返工处置后，一次合格率改善
  const newFpy = Math.min(0.999, base.fpy + scrapDelta + (reworkScheduled ? 0.03 : 0));

  return {
    ...base,
    defectRate: Number(newDefectRate.toFixed(4)),
    scrapRate: Number(newScrapRate.toFixed(4)),
    fpy: Number(newFpy.toFixed(4)),
    ...(quarantined ? { actionApplied: "quarantined" } : {}),
    ...(scrapped ? { actionApplied: "scrapped" } : {}),
    ...(reworkScheduled ? { actionApplied: "reworkScheduled" } : {}),
  };
}

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
        const q = applyQualityOverrides(ctx, getQuality(ctx));
        const { defectRate, fpy, scrapRate, actionApplied } = q as typeof q & { actionApplied?: string };
        return { defectRate, fpy, scrapRate, threshold: 0.03, ...(actionApplied ? { actionApplied } : {}) };
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
        const q = applyQualityOverrides(ctx, getQuality(ctx));
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
        const q = applyQualityOverrides(ctx, getQuality(ctx));
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
        const q = applyQualityOverrides(ctx, getQuality(ctx));
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
        const q = applyQualityOverrides(ctx, getQuality(ctx));
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

    // 9. 5M1E 根因框架（布尔标签版，轻量快速判定）
    createQueryTool({
      name: "quality.root_cause_5m1e",
      description: "按 5M1E（人/机/料/法/环/测）框架快速罗列可疑根因标签。轻量版：每分支返回布尔可疑判定，适合快速锁定方向。",
      triggers: ["5M1E", "根因分析", "为什么不良", "质量根因"],
      notFor: ["完整鱼骨图展开（走 quality.fishbone）", "5Why 逐层追问（走 quality.five_why）"],
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

    // 10. 5Why 根因追问
    createQueryTool({
      name: "quality.five_why",
      description: "按 5Why 方法对当前质量问题逐层追问根因（现象→直接原因→…→根本原因）。每链 5 层，附停止判定标准（到达物理根因/无可追问）。normal 场景无问题则返回空链。",
      triggers: ["5Why", "5个为什么", "逐层追问", "根本原因追问", "为何问题", "why分析"],
      notFor: ["5M1E 并行展开（走 quality.fishbone）", "FMEA 风险评分（走 process.fmea）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const cc = getCausalChain(ctx);
        const chains = cc.chains.map((c) => ({
          method: c.method,
          layers: c.layers,
          rootCause: c.rootCause,
          stopCriteria:
            "到达物理根因（如'滤网堵塞'是可物理干预的最终环节）或无可继续追问的下一层",
          depthReached: c.layers.length,
        }));
        return {
          symptom: cc.symptom,
          chains,
          hasIdentifiedRoot: chains.length > 0,
          note: chains.length === 0
            ? "当前场景无显著问题（normal），无可追溯的因果链"
            : "已识别根本原因，建议结合 quality.fishbone 交叉验证后再下结论",
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/5why?line=${(a.line as string) ?? "L01"}`,
      confidence: "inferred",
    }),

    // 11. 鱼骨图（5M1E 带证据完整版）
    createQueryTool({
      name: "quality.fishbone",
      description: "输出完整鱼骨图（石川图）：5M1E 六分支，每分支带具体证据引用（指向 mock 字段，非空泛描述）。适合多因素并行排查与 5Why 交叉印证。",
      triggers: ["鱼骨图", "石川图", "fishbone", "因果图", "多因素根因", "5M1E展开"],
      notFor: ["快速 5M1E 标签（走 quality.root_cause_5m1e）", "逐层追问（走 quality.five_why）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const cc = getCausalChain(ctx);
        const branches = [
          { dimension: "人 (Man)", factors: cc.fishbone.man },
          { dimension: "机 (Machine)", factors: cc.fishbone.machine },
          { dimension: "料 (Material)", factors: cc.fishbone.material },
          { dimension: "法 (Method)", factors: cc.fishbone.method },
          { dimension: "环 (Environment)", factors: cc.fishbone.environment },
          { dimension: "测 (Measurement)", factors: cc.fishbone.measurement },
        ];
        const nonEmpty = branches.filter((b) => b.factors.length > 0);
        const topSuspect =
          nonEmpty.length === 0
            ? "无显著异常（normal 场景）"
            : nonEmpty.sort((a, b) => b.factors.length - a.factors.length)[0]?.dimension ?? "无";
        return {
          symptom: cc.symptom,
          branches,
          topSuspect,
          excludedDimensions: branches.filter((b) => b.factors.length === 0).map((b) => b.dimension),
          note: "每分支证据指向具体 mock 字段，可用 nexus_advise 进一步交叉验证",
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/fishbone?line=${(a.line as string) ?? "L01"}`,
      confidence: "inferred",
    }),
  ];
}

export type { ScenarioId };
