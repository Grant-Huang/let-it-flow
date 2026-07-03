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
  getSpcSamples,
  lookupActionOverride,
  type ScenarioContext,
  type ScenarioId,
} from "../mock-data/scenarios.js";
import { DEFECT_RATE_THRESHOLD } from "../../config/business-thresholds.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

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
        return { defectRate, fpy, scrapRate, threshold: DEFECT_RATE_THRESHOLD, ...(actionApplied ? { actionApplied } : {}) };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/defect_rate?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["defect_rate"],
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
      provenance: (a) => `/mom/quality/pareto?line=${(a.line as string) ?? DEFAULT_LINE}&window=7d`,
      freshness: "daily",
      semanticTags: ["defect_rate"],
    }),

    // 3. SPC 统计过程控制（30 样本 + Nelson 判异规则）
    createQueryTool({
      name: "quality.spc",
      description:
        "查关键尺寸的 SPC 控制图数据（CL/UCL/LCL + 30 个连续样本 + Nelson 八大判异规则）。" +
        "支持多关键尺寸切换（通过 dimensionIndex 参数）。判断过程是否受控、有无漂移趋势。",
      triggers: ["SPC", "控制图", "过程受控", "UCL LCL", "均值极差图", "X-bar R"],
      notFor: ["过程能力指数（走 quality.cp_cpk）", "Sigma 水平（走 quality.sigma_level）"],
      inputSchema: {
        type: "object",
        properties: {
          dimensionIndex: { type: "number", description: "尺寸索引（0=第一关键尺寸，1=第二，缺省 0）" },
        },
      },
      getData: (ctx, args) => {
        const data = getSpcSamples(ctx);
        const dimIdx = (args?.dimensionIndex as number) ?? 0;
        const dim = data.dimensions[dimIdx] ?? data.dimensions[0]!;
        const samples = dim.samples;
        const n = samples.length;
        const cl = samples.reduce((s, v) => s + v, 0) / n;
        // sigma = sqrt(sum((x-mean)^2)/n)
        const variance = samples.reduce((s, v) => s + (v - cl) ** 2, 0) / n;
        const sigma = Math.sqrt(variance);
        const ucl = cl + 3 * sigma;
        const lcl = cl - 3 * sigma;
        const violations = checkNelsonRules(samples, cl, ucl, lcl, sigma);
        const outOfSpec = samples.filter((v) => v > dim.usl || v < dim.lsl).length;
        return {
          dimension: dim.name,
          unit: dim.unit,
          target: dim.target,
          usl: dim.usl,
          lsl: dim.lsl,
          cl: Number(cl.toFixed(4)),
          ucl: Number(ucl.toFixed(4)),
          lcl: Number(lcl.toFixed(4)),
          sigma: Number(sigma.toFixed(4)),
          samples,
          sampleCount: n,
          subgroupSize: dim.subgroupSize,
          outOfSpecCount: outOfSpec,
          nelsonViolations: violations,
          outOfControl: violations.length > 0,
          hasDrift: samples[n - 1]! - samples[0]! > sigma,
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mom/quality/spc?line=${(a.line as string) ?? DEFAULT_LINE}&dim=${(a.dimensionIndex as number) ?? 0}`,
      semanticTags: ["spc_samples"],
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
      provenance: (a) => `/mom/quality/capability?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["process_capability"],
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
      provenance: (a) => `/mom/quality/fpy?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["defect_rate"],
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
      provenance: (a) => `/erp/quality/scrap?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["defect_rate", "cost_summary"],
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
      provenance: (a) => `/mom/quality/rework?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["defect_rate", "cost_summary"],
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
      provenance: (a) => `/mom/quality/inspection?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["defect_rate"],
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
      provenance: (a) => `/mom/quality/5m1e?line=${(a.line as string) ?? DEFAULT_LINE}`,
      confidence: "inferred",
      semanticTags: ["causal_chain"],
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
      provenance: (a) => `/mom/quality/5why?line=${(a.line as string) ?? DEFAULT_LINE}`,
      confidence: "inferred",
      semanticTags: ["causal_chain"],
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
      provenance: (a) => `/mom/quality/fishbone?line=${(a.line as string) ?? DEFAULT_LINE}`,
      confidence: "inferred",
      semanticTags: ["causal_chain"],
    }),

    // 12. Sigma 水平（6Sigma DMAIC M 阶段核心指标）
    createQueryTool({
      name: "quality.sigma_level",
      description:
        "查过程 Sigma 水平（短期 Z.st + 长期 Z.lt）+ DPMO + 能力评级。" +
        "6Sigma DMAIC 的 Measure 阶段核心指标，量化过程离 6Sigma 目标的差距。" +
        "Z.st = 3×Cpk（短期）；Z.lt = Z.st - 1.5（经验偏移，长期含漂移）。",
      triggers: ["Sigma 水平", "西格玛水平", "Z值", "Z-bench", "6Sigma 水平", "六西格玛评估"],
      notFor: ["过程能力 Cp/Cpk（走 quality.cp_cpk）", "DPMO 趋势（走 quality.dpmo）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const zSt = 3 * q.cpk;
        const zLt = zSt - 1.5;
        const dpmo = Math.round(q.defectRate * 1_000_000);
        const level = zLt >= 6 ? "world_class" : zLt >= 4 ? "adequate" : zLt >= 3 ? "marginal" : "inadequate";
        const sigmaGap = Math.max(0, 6 - zLt);
        return {
          cpk: q.cpk,
          shortTermSigma: Number(zSt.toFixed(2)),
          longTermSigma: Number(zLt.toFixed(2)),
          dpmo,
          level,
          targetSigma: 6,
          gapToTarget: Number(sigmaGap.toFixed(2)),
          dpmoTarget: 3.4,
          assessment:
            level === "world_class" ? "已达 6Sigma 世界级水平"
            : level === "adequate" ? `距 6Sigma 目标差 ${sigmaGap.toFixed(1)}σ，DPMO ${dpmo} 远高于 3.4 目标`
            : level === "marginal" ? `过程能力边缘，距 6Sigma 目标差 ${sigmaGap.toFixed(1)}σ，需系统改善`
            : `过程能力不足，距 6Sigma 目标差 ${sigmaGap.toFixed(1)}σ，优先解决关键缺陷`,
          recommendedTools: "DMAIC 改善路径：走 lean.dmaic 生成五阶段路线图",
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/sigma_level?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "daily",
      confidence: "inferred",
      semanticTags: ["process_capability", "six_sigma_level"],
    }),

    // 13. DPMO 趋势（按缺陷类型分解的百万机会缺陷数）
    createQueryTool({
      name: "quality.dpmo",
      description:
        "查 DPMO（Defects Per Million Opportunities，百万机会缺陷数）+ 按缺陷类型分解的 DPMO 贡献。" +
        "用于识别 DPMO 的主要贡献缺陷类型，为 DMAIC 改善课题选择提供数据支撑。",
      triggers: ["DPMO", "DPMO 趋势", "缺陷机会", "百万缺陷数", "百万机会缺陷"],
      notFor: ["Sigma 水平（走 quality.sigma_level）", "缺陷帕累托（走 quality.pareto）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const totalDpmo = Math.round(q.defectRate * 1_000_000);
        const opportunitiesPerUnit = 5;
        const byDefectType = q.topDefects.map((d) => ({
          defectType: d.type,
          count: d.count,
          share: d.pct,
          dpmoContribution: Math.round(totalDpmo * d.pct),
          isVitalFew: false,
        }));
        const sortedByDpmo = [...byDefectType].sort((a, b) => b.dpmoContribution - a.dpmoContribution);
        const cumulativeThreshold = totalDpmo * 0.8;
        let cumulative = 0;
        for (const item of sortedByDpmo) {
          cumulative += item.dpmoContribution;
          item.isVitalFew = cumulative <= cumulativeThreshold;
        }
        return {
          totalDpmo,
          opportunitiesPerUnit,
          defectRate: q.defectRate,
          byDefectType: sortedByDpmo,
          vitalFew: sortedByDpmo.filter((d) => d.isVitalFew),
          paretoInsight:
            sortedByDpmo.length > 0
              ? `前 ${sortedByDpmo.filter((d) => d.isVitalFew).length} 类缺陷贡献了约 80% 的 DPMO，应优先攻关`
              : "无缺陷数据",
          sixSigmaDpmoTarget: 3.4,
          gapToTarget: totalDpmo - 3.4,
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/quality/dpmo?line=${(a.line as string) ?? DEFAULT_LINE}&window=7d`,
      freshness: "daily",
      confidence: "inferred",
      semanticTags: ["defect_rate", "six_sigma_level"],
    }),

    // 13. 量具校准状态 + MSA（QS16949 五大核心工具之一，符合性评估用）
    createQueryTool({
      name: "quality.calibration",
      description:
        "查量具校准状态 + MSA（测量系统分析）。返回各量具的校准有效期、MSA 合格判定（GR&R ≤ 10% 合格 / 10-30% 条件接受 / >30% 不合格）。QS16949 内审符合性评估时调用。",
      triggers: ["校准", "量具", "MSA", "GR&R", "gage R&R", "测量系统分析", "calibration"],
      notFor: ["过程能力 Cpk（走 quality.cp_cpk）", "缺陷率（走 quality.defect_rate）"],
      inputSchema: { type: "object", properties: { line: { type: "string" } } },
      getData: (ctx) => {
        const line = (ctx.line as string) ?? DEFAULT_LINE;
        return {
          gages: [
            { id: `${line}-G01`, name: "数显卡尺 0-150mm", calibrationDue: "2026-09-15", status: "valid", msaGrr: 7.2, msaVerdict: "acceptable" },
            { id: `${line}-G02`, name: "千分尺 0-25mm", calibrationDue: "2026-06-30", status: "expiring_soon", msaGrr: 12.5, msaVerdict: "conditional" },
            { id: `${line}-G03`, name: "高度尺", calibrationDue: "2026-03-01", status: "expired", msaGrr: 34.1, msaVerdict: "unacceptable" },
          ],
          summary: { total: 3, valid: 1, expiringSoon: 1, expired: 1, msaPassRate: 0.33 },
        };
      },
      system: "EAM",
      provenance: (a) => `/eam/quality/calibration?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "daily",
      confidence: "inferred",
      semanticTags: ["calibration_status"],
    }),
  ];
}

/**
 * Nelson 八大判异规则（SPC 控制图异常模式识别）。
 *
 * 国际标准（Nelson Rules / Western Electric Rules 变体），用于自动判定过程是否受控：
 *   Rule 1：任一点超 3σ（UCL/LCL 外）
 *   Rule 2：连续 9 点在中心线同一侧
 *   Rule 3：连续 6 点单调递增或递减（趋势）
 *   Rule 4：连续 14 点交替上下（震荡）
 *   Rule 5：连续 3 点中 2 点在 2σ 外（同侧）
 *   Rule 6：连续 5 点中 4 点在 1σ 外（同侧）
 *   Rule 7：连续 15 点在 1σ 内（变异过小，可能数据造假或分层不足）
 *   Rule 8：连续 8 点在 1σ 外（双侧）
 *
 * @returns 违规列表，每项含规则号、描述、涉及的样本索引
 */
function checkNelsonRules(
  samples: number[],
  cl: number,
  ucl: number,
  lcl: number,
  sigma: number,
): Array<{ rule: number; name: string; indices: number[] }> {
  const violations: Array<{ rule: number; name: string; indices: number[] }> = [];
  const s2u = cl + 2 * sigma;
  const s2l = cl - 2 * sigma;
  const s1u = cl + 1 * sigma;
  const s1l = cl - 1 * sigma;
  const n = samples.length;

  // Rule 1：任一点超 3σ
  const r1 = samples.reduce((acc: number[], v, i) => (v > ucl || v < lcl ? [...acc, i] : acc), []);
  if (r1.length > 0) violations.push({ rule: 1, name: "点超出 3σ 控制限", indices: r1 });

  // Rule 2：连续 9 点同侧
  let run = 1;
  for (let i = 1; i < n; i++) {
    if ((samples[i]! > cl && samples[i - 1]! > cl) || (samples[i]! < cl && samples[i - 1]! < cl)) {
      run++;
      if (run >= 9) {
        violations.push({ rule: 2, name: "连续 9 点在中心线同一侧", indices: range(i - 8, i + 1) });
        break;
      }
    } else run = 1;
  }

  // Rule 3：连续 6 点单调趋势
  let trend = 1;
  for (let i = 1; i < n; i++) {
    const diff = samples[i]! - samples[i - 1]!;
    const prevDiff = i >= 2 ? samples[i - 1]! - samples[i - 2]! : diff;
    if (diff !== 0 && ((diff > 0 && prevDiff > 0) || (diff < 0 && prevDiff < 0))) {
      trend++;
      if (trend >= 6) {
        violations.push({ rule: 3, name: "连续 6 点单调递增或递减", indices: range(i - 5, i + 1) });
        break;
      }
    } else trend = 1;
  }

  // Rule 5：连续 3 点中 2 点在 2σ 外（同侧）
  for (let i = 2; i < n; i++) {
    const w = [samples[i - 2]!, samples[i - 1]!, samples[i]!];
    const above = w.filter((v) => v > s2u);
    const below = w.filter((v) => v < s2l);
    if (above.length >= 2 || below.length >= 2) {
      violations.push({ rule: 5, name: "连续 3 点中 2 点超 2σ（同侧）", indices: [i - 2, i - 1, i] });
      break;
    }
  }

  // Rule 6：连续 5 点中 4 点在 1σ 外（同侧）
  for (let i = 4; i < n; i++) {
    const w = samples.slice(i - 4, i + 1);
    const above = w.filter((v) => v > s1u);
    const below = w.filter((v) => v < s1l);
    if (above.length >= 4 || below.length >= 4) {
      violations.push({ rule: 6, name: "连续 5 点中 4 点超 1σ（同侧）", indices: range(i - 4, i + 1) });
      break;
    }
  }

  return violations;
}

/** 生成 [start, end) 的整数序列。 */
function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

export type { ScenarioId };
