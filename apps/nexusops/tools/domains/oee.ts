/**
 * OEE 分析域工具集（应用层 —— T 内容）。
 *
 * OEE（Overall Equipment Effectiveness）= 可用率 × 性能率 × 质量率。
 * 这是精益生产最核心的综合效率指标。本域工具让 LLM 能从多角度取证 OEE 状态。
 *
 * 数据源：MES（实测）+ MOM（汇总）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getOEE,
  getOEEAllLines,
  getOEEByShift,
  getQuality,
  lookupActionOverride,
  type ScenarioContext,
  type ScenarioId,
} from "../mock-data/scenarios.js";

const SYSTEM = "MES";

/**
 * 应用动作副作用覆盖到 OEE 数据。
 *
 * 闭环逻辑：执行 mcp.eam.stop_line / mcp.process.adjust_parameters 后，
 * actionStore 写入 sideEffects；读取侧消费之，使"执行→复检"反映变化。
 *
 * - equipment.lineStopped：停线（destructive）→ 可用率崩至 0，OEE 归零
 * - process.adjusted：工艺参数回调 → 性能率回升（参数回正后降速/小停机减少）
 */
function applyOeeOverrides(ctx: ScenarioContext, base: ReturnType<typeof getOEE>) {
  const lineStopped = lookupActionOverride(ctx, "equipment.lineStopped") === true;
  const processAdjusted = lookupActionOverride(ctx, "process.adjusted") === true;

  if (!lineStopped && !processAdjusted) return base;

  if (lineStopped) {
    // 停线：可用率=0，性能率=0（不运行），质量率保持（已有产出），OEE=0
    return {
      ...base,
      availability: 0,
      performance: 0,
      oee: 0,
      actionApplied: "line_stopped",
    };
  }

  // process.adjusted：参数回调后性能率回升（升回 0.95，模拟参数回正后降速损失消除）
  const perfBoost = processAdjusted ? Math.min(0.95, base.performance + 0.08) : base.performance;
  const newOee = base.availability * perfBoost * base.quality;
  return {
    ...base,
    performance: Number(perfBoost.toFixed(4)),
    oee: Number(newOee.toFixed(4)),
    ...(processAdjusted ? { actionApplied: "process_adjusted" } : {}),
  };
}

export function registerOeeTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 实时 OEE
    createQueryTool({
      name: "oee.realtime",
      description: "查指定产线的实时 OEE（含可用率/性能率/质量率分解）。这是诊断效率问题的第一取证点。",
      triggers: ["查 OEE", "实时综合效率", "产线效率多少", "可用率性能率质量率"],
      notFor: ["历史 OEE 趋势（走 oee.history）", "全产线对比（走 oee.compare）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => applyOeeOverrides(ctx, getOEE(ctx)),
      system: SYSTEM,
      provenance: (a) => `/mes/oee/realtime?line=${(a.line as string) ?? "L01"}`,
    }),

    // 2. 历史 OEE 趋势（7 天）
    createQueryTool({
      name: "oee.history",
      description: "查指定产线近 7 天 OEE 趋势。用于判断是突发下滑还是长期恶化。",
      triggers: ["OEE 趋势", "近期效率变化", "OEE 历史曲线", "效率下滑多久了"],
      notFor: ["实时单点 OEE（走 oee.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => ({ trend7d: getOEE(ctx).trend7d, scenarioId: ctx.scenarioId }),
      system: SYSTEM,
      provenance: (a) => `/mes/oee/history?line=${(a.line as string) ?? "L01"}&days=7`,
      freshness: "daily",
    }),

    // 3. OEE 分解（损失瀑布）
    createQueryTool({
      name: "oee.decompose",
      description: "把 OEE 分解成可用率/性能率/质量率三项损失瀑布，定位最大损失项。",
      triggers: ["OEE 损失分解", "可用率损失", "性能损失", "质量损失", "效率损失在哪"],
      notFor: ["只看总 OEE（走 oee.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const o = applyOeeOverrides(ctx, getOEE(ctx));
        return {
          availabilityLoss: 1 - o.availability,
          performanceLoss: 1 - o.performance,
          qualityLoss: 1 - o.quality,
          totalLoss: 1 - o.oee,
          biggestLoss:
            o.availability < o.performance && o.availability < o.quality
              ? "availability"
              : o.performance < o.quality
                ? "performance"
                : "quality",
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/decompose?line=${(a.line as string) ?? "L01"}`,
    }),

    // 4. 瓶颈产线识别
    createQueryTool({
      name: "oee.bottleneck",
      description: "在多产线中识别 OEE 最低的瓶颈产线。用于全局视角的改善优先级排序。",
      triggers: ["哪个产线最差", "瓶颈产线", "效率最低产线", "改善优先级"],
      notFor: ["单产线详情（走 oee.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const all = getOEEAllLines(ctx.scenarioId);
        const sorted = [...all].sort((a, b) => a.oee - b.oee);
        return {
          bottleneck: sorted[0],
          ranking: sorted,
        };
      },
      system: "MOM",
      provenance: () => `/mom/oee/bottleneck`,
    }),

    // 5. OEE 趋势（环比）
    createQueryTool({
      name: "oee.trend",
      description: "查 OEE 环比变化（本周 vs 上周），判断是改善还是恶化。",
      triggers: ["OEE 环比", "效率比上周", "趋势恶化", "趋势改善"],
      notFor: ["绝对值查询（走 oee.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const o = getOEE(ctx);
        const lastWeek = o.trend7d[0] ?? o.oee;
        const thisWeek = o.oee;
        return {
          thisWeek,
          lastWeek,
          delta: thisWeek - lastWeek,
          direction: thisWeek > lastWeek ? "improving" : "declining",
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/trend?line=${(a.line as string) ?? "L01"}`,
      freshness: "weekly",
    }),

    // 6. 按班次分解 OEE
    createQueryTool({
      name: "oee.by_shift",
      description: "按 A/B/C 班次分解 OEE，识别班次差异（可能涉及人员/交接班问题）。",
      triggers: ["班次 OEE", "夜班效率", "各班次对比", "班次差异"],
      notFor: ["单班次详情（走 oee.realtime 指定班次）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const shiftData = getOEEByShift(ctx);
        const ranked = [...shiftData].sort((a, b) => b.oee - a.oee);
        const best = ranked[0]!;
        const worst = ranked[ranked.length - 1]!;
        return {
          shifts: shiftData,
          bestShift: best.shift,
          worstShift: worst.shift,
          gap: best.oee - worst.oee,
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/by_shift?line=${(a.line as string) ?? "L01"}`,
      freshness: "shift",
    }),

    // 7. 按产线分解
    createQueryTool({
      name: "oee.by_line",
      description: "查全产线 OEE 对比矩阵（不排序，原始数据）。",
      triggers: ["产线 OEE 对比", "各产线效率", "产线矩阵"],
      notFor: ["排序找瓶颈（走 oee.bottleneck）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => ({ lines: getOEEAllLines(ctx.scenarioId) }),
      system: "MOM",
      provenance: () => `/mom/oee/by_line`,
    }),

    // 8. 产线间对比
    createQueryTool({
      name: "oee.compare",
      description: "对比两条产线的 OEE 差异，定位差异来源（设备/工艺/人员）。",
      triggers: ["对比产线", "两条产线差异", "L01 vs L02"],
      notFor: ["全产线矩阵（走 oee.by_line）"],
      inputSchema: {
        type: "object",
        properties: {
          line2: { type: "string", enum: ["L01", "L02", "L03"], description: "对比的另一条产线" },
        },
      },
      getData: (ctx, args) => {
        const all = getOEEAllLines(ctx.scenarioId);
        const line1 = ctx.line ?? "L01";
        const line2 = (args.line2 as typeof line1) ?? "L02";
        const a = all.find((x) => x.line === line1);
        const b = all.find((x) => x.line === line2);
        return { line1: a, line2: b, delta: (a?.oee ?? 0) - (b?.oee ?? 0) };
      },
      system: "MOM",
      provenance: (a) => `/mom/oee/compare?l1=${(a.line as string) ?? "L01"}&l2=${(a.line2 as string) ?? "L02"}`,
    }),

    // 9. 可用率损失明细
    createQueryTool({
      name: "oee.availability_loss",
      description: "查可用率损失的具体构成（计划停机 vs 故障停机 vs 换模）。需配合 equipment.downtime 取停机原因。",
      triggers: ["可用率损失", "停机损失构成", "为什么可用率低"],
      notFor: ["故障停机原因详情（走 equipment.downtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const o = getOEE(ctx);
        return {
          availability: o.availability,
          lossBreakdown: {
            planned: 0.04,
            unplanned: 1 - o.availability - 0.04 - 0.02,
            changeover: 0.02,
          },
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/availability_loss?line=${(a.line as string) ?? "L01"}`,
    }),

    // 10. 性能损失明细
    createQueryTool({
      name: "oee.performance_loss",
      description: "查性能率损失来源（小停机/降速/空转）。性能低通常关联工艺参数偏移。",
      triggers: ["性能损失", "降速损失", "小停机", "为什么性能率低"],
      notFor: ["工艺参数详情（走 process.parameters）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const o = getOEE(ctx);
        return {
          performance: o.performance,
          lossBreakdown: { minorStops: 0.06, speedLoss: 1 - o.performance - 0.06, idling: 0.02 },
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/performance_loss?line=${(a.line as string) ?? "L01"}`,
    }),

    // 11. 质量损失明细
    createQueryTool({
      name: "oee.quality_loss",
      description: "查质量率损失来源（报废/返工/降级）。质量低关联具体缺陷类型（走 quality.pareto）。",
      triggers: ["质量损失", "报废损失", "返工损失", "为什么质量率低"],
      notFor: ["缺陷类型详情（走 quality.pareto）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const o = getOEE(ctx);
        return {
          quality: o.quality,
          lossBreakdown: { scrap: (1 - o.quality) * 0.6, rework: (1 - o.quality) * 0.3, downgrade: (1 - o.quality) * 0.1 },
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/quality_loss?line=${(a.line as string) ?? "L01"}`,
    }),

    // oee.report_html 已迁移为 skill.report_html（见 skills/report-html.ts），
    // 通过 ctx.call 串联 Layer 1 工具，而非直取多域 accessor。
  ];
}

export type { ScenarioId };
