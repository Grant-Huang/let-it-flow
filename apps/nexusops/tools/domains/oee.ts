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
  getEquipment,
  getQuality,
  getProcess,
  getCausalChain,
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

    // 12. OEE 综合诊断 HTML 报告（右栏渲染）
    createQueryTool({
      name: "oee.report_html",
      description:
        "生成 OEE 综合诊断的自包含 HTML 报告，在右栏以图表 + 根因树 + 建议面板展示。报告内嵌 CSS，无外部依赖，可直接 iframe 渲染。建议有行动项时，报告中包含执行按钮（通过 postMessage 触发 HITL 确认）。",
      triggers: [
        "生成报告",
        "OEE 报告",
        "可视化诊断",
        "展示诊断结果",
        "html 报告",
        "右栏显示报告",
      ],
      notFor: ["只查 OEE 数值（走 oee.realtime）", "只查根因（走 skill.oee_diagnose）"],
      inputSchema: {
        type: "object",
        properties: {
          primaryRootCause: { type: "string" },
          mechanismExplained: { type: "string" },
          auxiliaryFactors: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          recommendations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                rationale: { type: "string" },
                impact: { type: "number" },
                executionScore: { type: "number" },
                actionTool: { type: "string" },
                actionArgs: { type: "object" },
              },
            },
          },
        },
      },
      getData: (ctx, args) => {
        const oee = getOEE(ctx);
        const eq = getEquipment(ctx);
        const q = getQuality(ctx);
        const pr = getProcess(ctx);
        const cc = getCausalChain(ctx);

        const a = (args ?? {}) as {
          primaryRootCause?: string;
          mechanismExplained?: string;
          auxiliaryFactors?: string[];
          confidence?: number;
          recommendations?: Array<{
            title?: string;
            rationale?: string;
            impact?: number;
            executionScore?: number;
            actionTool?: string;
            actionArgs?: Record<string, unknown>;
          }>;
        };

        const primaryRootCause = a.primaryRootCause ??
          (cc.chains.length > 0 ? cc.chains[0]!.rootCause : "待定（当前场景无已识别根因）");
        const mechanismExplained = a.mechanismExplained ??
          (cc.chains.length > 0 ? cc.chains[0]!.layers.join(" → ") : "");
        const auxiliaryFactors = a.auxiliaryFactors ?? [...cc.fishbone.man.slice(0, 2), ...cc.fishbone.material.slice(0, 1)];
        const confidence = a.confidence ?? (cc.chains.length > 0 ? 0.88 : 0.4);
        const recs = a.recommendations ?? [];

        // 7-day OEE trend (mock: interpolate from target to current)
        const trend7d = Array.from({ length: 7 }, (_, i) => {
          const t = i / 6;
          const v = oee.target * (1 - t * (1 - oee.oee / oee.target));
          return (v * 100).toFixed(1);
        });

        const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
        const color = (v: number, threshold = 0.8) => v >= threshold ? "#22c55e" : v >= 0.65 ? "#f59e0b" : "#ef4444";

        // Build mini SVG trend line
        const svgPoints = trend7d
          .map((v, i) => `${(i / 6) * 220},${80 - (parseFloat(v) / 100) * 70}`)
          .join(" ");

        // Evidence chain rows
        const evidenceRows = [
          { tool: "oee.realtime", data: `OEE=${pct(oee.oee)}，目标=${pct(oee.target)}`, step: "基础指标" },
          { tool: "equipment.health", data: `健康分=${eq.healthScore.toFixed(2)}，故障风险=${pct(eq.failureRisk30d)}`, step: "设备取证" },
          { tool: "quality.defects", data: `不良率=${pct(q.defectRate)}，Cpk=${q.cpk.toFixed(2)}`, step: "质量取证" },
          { tool: "process.deviation", data: `偏离分=${pr.deviationScore.toFixed(2)}`, step: "工艺取证" },
          ...(cc.chains.length > 0
            ? [{ tool: "quality.five_why", data: `根因：${cc.chains[0]!.rootCause}`, step: "因果链取证" }]
            : [{ tool: "quality.five_why", data: "无已识别因果链（normal 场景）", step: "因果链取证" }]),
        ];

        // 5Why layers for root cause tree
        const fiveWhyLayers = cc.chains.length > 0 ? cc.chains[0]!.layers : [];

        // Recommendations HTML
        const recsHtml = recs.length === 0 ? `<p style="color:#6b7280;font-size:13px;">暂无结构化建议（请先调用 nexus_advise 生成建议）</p>` :
          recs.map((rec, i) => {
            const hasAction = typeof rec.actionTool === "string" && rec.actionTool;
            const argsJson = rec.actionArgs ? JSON.stringify(rec.actionArgs) : "{}";
            const impactPct = Math.round((rec.impact ?? 0) * 100);
            const execPct = Math.round((rec.executionScore ?? 0) * 100);
            return `
            <div class="rec-card">
              <div class="rec-header">
                <span class="rec-idx">#${i + 1}</span>
                <span class="rec-title">${escapeHtml(rec.title ?? "建议")}</span>
                ${hasAction ? `<span class="badge badge-action">可执行</span>` : ""}
              </div>
              <div class="rec-rationale">${escapeHtml(rec.rationale ?? "")}</div>
              <div class="rec-metrics">
                <div class="metric-bar">
                  <span class="metric-label">影响度</span>
                  <div class="bar-bg"><div class="bar-fill" style="width:${impactPct}%;background:#3b82f6"></div></div>
                  <span class="metric-val">${impactPct}%</span>
                </div>
                <div class="metric-bar">
                  <span class="metric-label">执行度</span>
                  <div class="bar-bg"><div class="bar-fill" style="width:${execPct}%;background:#8b5cf6"></div></div>
                  <span class="metric-val">${execPct}%</span>
                </div>
              </div>
              ${hasAction ? `
              <button class="action-btn" onclick="window.parent.postMessage({type:'nexus_mcp',tool:'${rec.actionTool}',args:${argsJson}},'*')">
                ▶ 执行：${escapeHtml(rec.actionTool ?? "")}
              </button>` : ""}
            </div>`;
          }).join("");

        const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OEE 诊断报告</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; font-size: 14px; line-height: 1.5; padding: 16px; }
  h2 { font-size: 16px; font-weight: 600; color: #f1f5f9; margin-bottom: 12px; }
  h3 { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .section { background: #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 12px; border: 1px solid #334155; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .kpi-card { background: #0f172a; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid #334155; }
  .kpi-label { font-size: 11px; color: #64748b; margin-bottom: 4px; }
  .kpi-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi-target { font-size: 10px; color: #475569; margin-top: 2px; }
  .trend-svg { width: 100%; height: 90px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #64748b; padding: 6px 8px; border-bottom: 1px solid #334155; font-weight: 500; }
  td { padding: 7px 8px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 7px; border-radius: 99px; font-weight: 600; }
  .badge-tool { background: #1e3a5f; color: #60a5fa; }
  .badge-action { background: #14532d; color: #4ade80; margin-left: 6px; }
  .badge-warn { background: #451a03; color: #fb923c; }
  .tree { font-size: 13px; line-height: 2; }
  .tree-root { color: #f87171; font-weight: 600; padding-left: 0; }
  .tree-layer { color: #94a3b8; padding-left: 20px; position: relative; }
  .tree-layer::before { content: "└ "; color: #475569; position: absolute; left: 4px; }
  .aux-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .aux-tag { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 3px 10px; font-size: 12px; color: #94a3b8; }
  .confidence-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .conf-label { font-size: 12px; color: #64748b; width: 60px; }
  .bar-bg { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .conf-val { font-size: 12px; color: #94a3b8; width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
  .rec-card { background: #0f172a; border-radius: 8px; padding: 12px; margin-bottom: 8px; border: 1px solid #334155; }
  .rec-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .rec-idx { font-size: 11px; color: #475569; font-weight: 600; }
  .rec-title { font-size: 13px; font-weight: 600; color: #f1f5f9; flex: 1; }
  .rec-rationale { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
  .rec-metrics { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .metric-bar { display: flex; align-items: center; gap: 6px; }
  .metric-label { font-size: 11px; color: #64748b; width: 40px; }
  .metric-val { font-size: 11px; color: #94a3b8; width: 32px; text-align: right; font-variant-numeric: tabular-nums; }
  .action-btn { background: #1d4ed8; color: #fff; border: none; border-radius: 6px; padding: 7px 14px; font-size: 12px; cursor: pointer; font-weight: 500; transition: background 0.15s; }
  .action-btn:hover { background: #2563eb; }
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .report-title { font-size: 18px; font-weight: 700; color: #f1f5f9; }
  .report-meta { font-size: 11px; color: #475569; }
</style>
</head>
<body>
<div class="header-row">
  <div class="report-title">OEE 综合诊断报告</div>
  <div class="report-meta">${ctx.line ?? "L01"} · 场景：${ctx.scenarioId} · ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>
</div>

<!-- KPI Dashboard -->
<div class="section">
  <h3>KPI 概览</h3>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">综合 OEE</div>
      <div class="kpi-value" style="color:${color(oee.oee, oee.target * 0.95)}">${pct(oee.oee)}</div>
      <div class="kpi-target">目标 ${pct(oee.target)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">可用率</div>
      <div class="kpi-value" style="color:${color(oee.availability)}">${pct(oee.availability)}</div>
      <div class="kpi-target">停机 ${eq.downtimeEvents.length} 起</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">性能率</div>
      <div class="kpi-value" style="color:${color(oee.performance)}">${pct(oee.performance)}</div>
      <div class="kpi-target">MTBF ${eq.mtbfHours}h</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">质量率</div>
      <div class="kpi-value" style="color:${color(oee.quality)}">${pct(oee.quality)}</div>
      <div class="kpi-target">不良率 ${pct(q.defectRate)}</div>
    </div>
  </div>
</div>

<!-- 7-Day Trend -->
<div class="section">
  <h3>OEE 7 日趋势</h3>
  <svg class="trend-svg" viewBox="0 0 240 90" preserveAspectRatio="none">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${80 - (oee.target * 100 / 100) * 70}" x2="240" y2="${80 - (oee.target * 100 / 100) * 70}" stroke="#334155" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="2" y="${78 - (oee.target * 100 / 100) * 70}" font-size="8" fill="#475569">目标 ${pct(oee.target)}</text>
    <polyline points="${svgPoints}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="220" cy="${80 - parseFloat(trend7d[6]!) * 0.7}" r="3" fill="#3b82f6"/>
  </svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:#475569;margin-top:4px">
    <span>-6d</span><span>-5d</span><span>-4d</span><span>-3d</span><span>-2d</span><span>昨</span><span>今</span>
  </div>
</div>

<!-- Evidence Chain -->
<div class="section">
  <h3>证据链</h3>
  <table>
    <thead><tr><th>工具</th><th>关键数据</th><th>推理步骤</th></tr></thead>
    <tbody>
      ${evidenceRows.map((r) => `
      <tr>
        <td><span class="badge badge-tool">${r.tool}</span></td>
        <td style="color:#cbd5e1">${r.data}</td>
        <td style="color:#64748b">${r.step}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>

<!-- Root Cause Tree -->
<div class="section">
  <h3>根因分析</h3>
  <div class="tree">
    <div class="tree-root">根因：${escapeHtml(primaryRootCause)}</div>
    ${fiveWhyLayers.map((layer, i) => `<div class="tree-layer" style="padding-left:${(i + 1) * 18}px">${escapeHtml(layer)}</div>`).join("")}
  </div>
  ${auxiliaryFactors.length > 0 ? `
  <div style="margin-top:12px">
    <div style="font-size:12px;color:#64748b;margin-bottom:6px">辅助因素</div>
    <div class="aux-list">
      ${auxiliaryFactors.map((f) => `<span class="aux-tag">${escapeHtml(f)}</span>`).join("")}
    </div>
  </div>` : ""}
  <div class="confidence-bar">
    <span class="conf-label">置信度</span>
    <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(confidence * 100)}%;background:${confidence > 0.7 ? "#22c55e" : confidence > 0.5 ? "#f59e0b" : "#ef4444"}"></div></div>
    <span class="conf-val">${Math.round(confidence * 100)}%</span>
  </div>
  ${mechanismExplained ? `<div style="margin-top:10px;font-size:12px;color:#64748b;line-height:1.6">机制路径：<span style="color:#94a3b8">${escapeHtml(mechanismExplained)}</span></div>` : ""}
</div>

<!-- Recommendations -->
<div class="section">
  <h3>改善建议</h3>
  ${recsHtml}
</div>

<script>
  // Forward nexus_mcp postMessages from action buttons to parent
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'nexus_mcp') {
      window.parent.postMessage(e.data, '*');
    }
  });
</script>
</body>
</html>`;

        return { html, _isHtmlReport: true };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/oee/report_html?line=${(a.line as string) ?? "L01"}`,
    }),
  ];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type { ScenarioId };
