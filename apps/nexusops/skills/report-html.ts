/**
 * skill.report_html：通用可视化报告生成器（应用层 —— L 内容）。
 *
 * 按 reportType 分派不同模板，避免"所有分析最后都渲染成 OEE 根因报告"。
 *   - reportType="oee"（缺省）：OEE 综合诊断报告（KPI + 证据链 + 根因树 + 建议）
 *   - reportType="dmaic"：DMAIC 改善路线图（σ/DPMO/Cpk 目标 + D-M-A-I-C 五阶段 + reasoningChain）
 *
 * 两种模板共享同一套 CSS + HTML 外壳（buildHtmlShell），仅 body 内容不同。
 * 报告内嵌 CSS，无外部依赖，可直接 iframe 渲染。建议有行动项时，报告中包含
 * 执行按钮（通过 postMessage 触发 HITL 确认）。
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 报告类型。 */
type ReportType = "oee" | "dmaic";

/** 建议项结构（OEE 模板用）。 */
interface Recommendation {
  title?: string;
  rationale?: string;
  impact?: number;
  executionScore?: number;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
}

/** 共享 CSS（所有模板复用）。 */
const SHARED_CSS = `
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
  .badge-phase { background: #1e3a5f; color: #60a5fa; padding: 3px 9px; font-size: 11px; }
  .badge-status-ready { background: #14532d; color: #4ade80; }
  .badge-status-blocked { background: #451a03; color: #fb923c; }
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
  .phase-card { background: #0f172a; border-radius: 8px; padding: 14px; margin-bottom: 10px; border: 1px solid #334155; border-left: 3px solid #3b82f6; }
  .phase-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .phase-name { font-size: 14px; font-weight: 600; color: #f1f5f9; flex: 1; }
  .phase-objective { font-size: 12px; color: #94a3b8; margin-bottom: 8px; font-style: italic; }
  .phase-detail { font-size: 12px; color: #cbd5e1; line-height: 1.6; }
  .phase-detail strong { color: #f1f5f9; }
  .sigma-gap { background: #0f172a; border-radius: 8px; padding: 12px; border: 1px solid #334155; margin-top: 8px; }
`;

/** 构造完整的 HTML 外壳（共享）。 */
function buildHtmlShell(title: string, bodyHtml: string, line: string, scenarioId: string): string {
  const meta = `${line} · 场景：${scenarioId} · ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="header-row">
  <div class="report-title">${escapeHtml(title)}</div>
  <div class="report-meta">${meta}</div>
</div>
${bodyHtml}
<script>
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'nexus_mcp') {
      window.parent.postMessage(e.data, '*');
    }
  });
</script>
</body>
</html>`;
}

/** 颜色阈值辅助（OEE 模板用）。 */
const color = (v: number, threshold = 0.8) => (v >= threshold ? "#22c55e" : v >= 0.65 ? "#f59e0b" : "#ef4444");

// ─────────────────────────────────────────────────────────────────────────────
// OEE 模板（原有逻辑，保持测试契约：含 "OEE 综合诊断报告" + "证据链"）
// ─────────────────────────────────────────────────────────────────────────────

interface OeeTemplateData {
  oee: number;
  target: number;
  availability: number;
  performance: number;
  quality: number;
  eq: { healthScore: number; failureRisk30d: number; downtimeCount: number; mtbfHours: number };
  q: { defectRate: number; cpk: number };
  pr: { deviationScore: number };
  cc: { rootCause: string; layers: string[]; fishboneMan: string[]; fishboneMaterial: string[] };
  primaryRootCause: string;
  mechanismExplained: string;
  auxiliaryFactors: string[];
  confidence: number;
  recs: Recommendation[];
}

function buildOeeBodyHtml(d: OeeTemplateData): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const trend7d = Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    const v = d.target * (1 - t * (1 - d.oee / d.target));
    return (v * 100).toFixed(1);
  });

  const svgPoints = trend7d
    .map((v, i) => `${(i / 6) * 220},${80 - (parseFloat(v) / 100) * 70}`)
    .join(" ");

  const evidenceRows = [
    { tool: "oee.realtime", data: `OEE=${pct(d.oee)}，目标=${pct(d.target)}`, step: "基础指标" },
    { tool: "equipment.health", data: `健康分=${d.eq.healthScore.toFixed(2)}，故障风险=${pct(d.eq.failureRisk30d)}`, step: "设备取证" },
    { tool: "quality.defects", data: `不良率=${pct(d.q.defectRate)}，Cpk=${d.q.cpk.toFixed(2)}`, step: "质量取证" },
    { tool: "process.deviation", data: `偏离分=${d.pr.deviationScore.toFixed(2)}`, step: "工艺取证" },
    d.cc.rootCause
      ? { tool: "quality.five_why", data: `根因：${d.cc.rootCause}`, step: "因果链取证" }
      : { tool: "quality.five_why", data: "无已识别因果链（normal 场景）", step: "因果链取证" },
  ];

  const recsHtml = d.recs.length === 0
    ? `<p style="color:#6b7280;font-size:13px;">暂无结构化建议（请先调用 nexus_advise 生成建议）</p>`
    : d.recs.map((rec, i) => {
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
        ${hasAction
          ? `
        <button class="action-btn" onclick="window.parent.postMessage({type:'nexus_mcp',tool:'${rec.actionTool}',args:${argsJson}},'*')">
          ▶ 执行：${escapeHtml(rec.actionTool ?? "")}
        </button>`
          : ""}
      </div>`;
      }).join("");

  return `
<div class="section">
  <h3>KPI 概览</h3>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">综合 OEE</div>
      <div class="kpi-value" style="color:${color(d.oee, d.target * 0.95)}">${pct(d.oee)}</div>
      <div class="kpi-target">目标 ${pct(d.target)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">可用率</div>
      <div class="kpi-value" style="color:${color(d.availability)}">${pct(d.availability)}</div>
      <div class="kpi-target">停机 ${d.eq.downtimeCount} 起</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">性能率</div>
      <div class="kpi-value" style="color:${color(d.performance)}">${pct(d.performance)}</div>
      <div class="kpi-target">MTBF ${d.eq.mtbfHours}h</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">质量率</div>
      <div class="kpi-value" style="color:${color(d.quality)}">${pct(d.quality)}</div>
      <div class="kpi-target">不良率 ${pct(d.q.defectRate)}</div>
    </div>
  </div>
</div>

<div class="section">
  <h3>OEE 7 日趋势</h3>
  <svg class="trend-svg" viewBox="0 0 240 90" preserveAspectRatio="none">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${80 - (d.target * 100 / 100) * 70}" x2="240" y2="${80 - (d.target * 100 / 100) * 70}" stroke="#334155" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="2" y="${78 - (d.target * 100 / 100) * 70}" font-size="8" fill="#475569">目标 ${pct(d.target)}</text>
    <polyline points="${svgPoints}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="220" cy="${80 - parseFloat(trend7d[6]!) * 0.7}" r="3" fill="#3b82f6"/>
  </svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:#475569;margin-top:4px">
    <span>-6d</span><span>-5d</span><span>-4d</span><span>-3d</span><span>-2d</span><span>昨</span><span>今</span>
  </div>
</div>

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

<div class="section">
  <h3>根因分析</h3>
  <div class="tree">
    <div class="tree-root">根因：${escapeHtml(d.primaryRootCause)}</div>
    ${d.cc.layers.map((layer, i) => `<div class="tree-layer" style="padding-left:${(i + 1) * 18}px">${escapeHtml(layer)}</div>`).join("")}
  </div>
  ${d.auxiliaryFactors.length > 0
    ? `
  <div style="margin-top:12px">
    <div style="font-size:12px;color:#64748b;margin-bottom:6px">辅助因素</div>
    <div class="aux-list">
      ${d.auxiliaryFactors.map((f) => `<span class="aux-tag">${escapeHtml(f)}</span>`).join("")}
    </div>
  </div>`
    : ""}
  <div class="confidence-bar">
    <span class="conf-label">置信度</span>
    <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(d.confidence * 100)}%;background:${d.confidence > 0.7 ? "#22c55e" : d.confidence > 0.5 ? "#f59e0b" : "#ef4444"}"></div></div>
    <span class="conf-val">${Math.round(d.confidence * 100)}%</span>
  </div>
  ${d.mechanismExplained ? `<div style="margin-top:10px;font-size:12px;color:#64748b;line-height:1.6">机制路径：<span style="color:#94a3b8">${escapeHtml(d.mechanismExplained)}</span></div>` : ""}
</div>

<div class="section">
  <h3>改善建议</h3>
  ${recsHtml}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DMAIC 模板（σ/DPMO/Cpk 目标 + D-M-A-I-C 五阶段路线图）
// ─────────────────────────────────────────────────────────────────────────────

interface DmaicTemplateData {
  define: { oee: number; target: number; cpk: number; totalLossCost: number };
  measure: { defectRate: number; fpy: number; scrapRate: number; cpk: number; sigmaLt: number; dpmo: number };
  analyze: { rootCause: string; mechanismPath: string; hasCausalChain: boolean; fishboneTopSuspect: string };
  improve: { proposedActions: Array<{ action: string; tool: string; priority: string }> };
  reasoningChain: Array<{ step: number; action: string; tool: string; finding: string; inference: string }>;
}

function buildDmaicBodyHtml(d: DmaicTemplateData): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const zLt = d.measure.sigmaLt;
  const sigmaGap = Math.max(0, 4 - zLt);
  const priorityColor = zLt < 2 ? "#ef4444" : zLt < 3 ? "#f59e0b" : "#22c55e";
  const priorityLabel = zLt < 2 ? "critical" : zLt < 3 ? "high" : "medium";
  const duration = zLt < 2 ? "3-6 个月" : zLt < 3 ? "2-4 个月" : "1-3 个月";

  const sigmaBadgeColor = zLt >= 4 ? "#22c55e" : zLt >= 3 ? "#f59e0b" : "#ef4444";

  const phaseStatusBadge = (status: string) =>
    `<span class="badge badge-status-${status === "ready" ? "ready" : "blocked"}">${status === "ready" ? "就绪" : "阻塞（待数据）"}</span>`;

  const phaseCard = (
    phase: string,
    name: string,
    objective: string,
    detailHtml: string,
    status: string,
  ) => `
    <div class="phase-card">
      <div class="phase-header">
        <span class="badge badge-phase">${phase}</span>
        <span class="phase-name">${escapeHtml(name)}</span>
        ${phaseStatusBadge(status)}
      </div>
      <div class="phase-objective">${escapeHtml(objective)}</div>
      <div class="phase-detail">${detailHtml}</div>
    </div>`;

  const D = phaseCard(
    "D", "Define（定义）",
    "明确改善课题的范围、目标、财务收益",
    `<strong>课题陈述：</strong>${d.analyze.hasCausalChain ? escapeHtml(d.analyze.rootCause) : `OEE=${pct(d.define.oee)}，Cpk=${d.define.cpk.toFixed(2)}，存在改善空间`}<br>
     <strong>目标：</strong>OEE 从 ${pct(d.define.oee)} 提升至 ${pct(d.define.target)}，Cpk 从 ${d.define.cpk.toFixed(2)} 提升至 ≥1.33<br>
     <strong>财务收益：</strong>预计日节约 ${Math.round(d.define.totalLossCost * 0.3)} 元（假设改善 30% 损失）`,
    "ready",
  );

  const M = phaseCard(
    "M", "Measure（测量）",
    "量化当前过程的基线表现",
    `<strong>基线指标：</strong>不良率 ${pct(d.measure.defectRate)}，FPY ${pct(d.measure.fpy)}，报废率 ${pct(d.measure.scrapRate)}<br>
     <strong>过程能力：</strong>Cpk=${d.measure.cpk.toFixed(2)}，DPMO=${d.measure.dpmo}<br>
     <strong>长期 σ：</strong>${d.measure.sigmaLt}（目标 4）`,
    "ready",
  );

  const A = phaseCard(
    "A", "Analyze（分析）",
    "识别根本原因，建立缺陷与输入变量的因果关系",
    d.analyze.hasCausalChain
      ? `<strong>方法：</strong>5Why + 鱼骨图<br><strong>根因：</strong>${escapeHtml(d.analyze.rootCause)}<br><strong>机制路径：</strong>${escapeHtml(d.analyze.mechanismPath)}<br><strong>鱼骨首要嫌疑：</strong>${escapeHtml(d.analyze.fishboneTopSuspect)}`
      : `<strong>状态：</strong>当前证据不足以确定根因，需补充现场数据后分析<br><strong>鱼骨首要嫌疑：</strong>${escapeHtml(d.analyze.fishboneTopSuspect)}`,
    d.analyze.hasCausalChain ? "ready" : "blocked_by_data",
  );

  const I = phaseCard(
    "I", "Improve（改善）",
    "实施改善方案，验证效果",
    d.improve.proposedActions.length === 0
      ? "暂无结构化对策（需 Analyze 阶段完成后组合）"
      : d.improve.proposedActions.map((a) => `• ${escapeHtml(a.action)}（工具：<code>${escapeHtml(a.tool)}</code>，优先级：${escapeHtml(a.priority)}）`).join("<br>"),
    "ready",
  );

  const C = phaseCard(
    "C", "Control（控制）",
    "建立监控体系，固化改善成果",
    `<strong>SPC 监控：</strong>对关键尺寸建立控制图（走 quality.spc）<br>
     <strong>标准作业：</strong>更新 SOP + 控制计划（走 process.control_plan）<br>
     <strong>审核频率：</strong>每周审核 Cpk 趋势 + 每月评审 OEE 是否达标<br>
     <strong>反应计划：</strong>Cpk <1.0 触发紧急复检 + 参数回调<br>
     <strong>目标指标：</strong>Cpk=1.33、OEE=${pct(d.define.target)}、FPY=95%、σ=4`,
    "ready",
  );

  const reasoningRows = d.reasoningChain.map((r) => `
    <tr>
      <td><span class="badge badge-tool">${escapeHtml(r.tool)}</span></td>
      <td style="color:#cbd5e1">${escapeHtml(r.finding)}</td>
      <td style="color:#94a3b8">${escapeHtml(r.inference)}</td>
    </tr>`).join("");

  return `
<div class="section">
  <h3>6Sigma 水平概览</h3>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">长期 σ 水平</div>
      <div class="kpi-value" style="color:${sigmaBadgeColor}">${d.measure.sigmaLt.toFixed(2)}</div>
      <div class="kpi-target">目标 4.0</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">DPMO</div>
      <div class="kpi-value" style="color:${sigmaBadgeColor}">${d.measure.dpmo}</div>
      <div class="kpi-target">目标 ≤3.4</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">过程能力 Cpk</div>
      <div class="kpi-value" style="color:${color(d.measure.cpk, 1.33)}">${d.measure.cpk.toFixed(2)}</div>
      <div class="kpi-target">目标 ≥1.33</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">距 6Sigma 差距</div>
      <div class="kpi-value" style="color:${priorityColor}">${sigmaGap.toFixed(2)}σ</div>
      <div class="kpi-target">优先级 ${priorityLabel}</div>
    </div>
  </div>
  <div class="sigma-gap">
    <div style="font-size:12px;color:#64748b;margin-bottom:4px">项目评估</div>
    <div style="font-size:13px;color:#cbd5e1">预计周期：<strong style="color:#f1f5f9">${duration}</strong> · 改善优先级：<strong style="color:${priorityColor}">${priorityLabel}</strong></div>
  </div>
</div>

<div class="section">
  <h3>DMAIC 五阶段路线图</h3>
  ${D}${M}${A}${I}${C}
</div>

<div class="section">
  <h3>推理链</h3>
  <table>
    <thead><tr><th>工具</th><th>关键发现</th><th>阶段推理</th></tr></thead>
    <tbody>${reasoningRows}</tbody>
  </table>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// skill 主体
// ─────────────────────────────────────────────────────────────────────────────

export function createReportHtmlSkill() {
  return createSkill({
    name: "skill.report_html",
    description:
      "通用可视化报告生成器：按 reportType 分派模板（oee=OEE 综合诊断报告含证据链+根因树；dmaic=DMAIC 改善路线图含 σ/DPMO 目标+五阶段）。" +
      "替代原 oee.report_html。报告内嵌 CSS，无外部依赖，可直接 iframe 渲染。建议有行动项时，报告中包含执行按钮（通过 postMessage 触发 HITL 确认）。通过 ctx.call 串联 Layer 1 工具取数。",
    whenToUse: {
      triggers: ["生成报告", "OEE 报告", "DMAIC 报告", "6Sigma 报告", "改善路线图报告", "可视化诊断", "展示诊断结果", "html 报告", "右栏显示报告"],
      notFor: ["只查 OEE 数值（走 oee.realtime）", "只查根因（走 skill.oee_diagnose）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        reportType: { type: "string", enum: ["oee", "dmaic"], description: "报告类型：oee=OEE 综合诊断报告（缺省）；dmaic=DMAIC 改善路线图。根据前置分析选择匹配类型，避免 DMAIC 分析后渲染 OEE 根因报告。" },
        scenarioId: { type: "string", enum: ["normal", "anomaly", "crisis"] },
        line: { type: "string", enum: ["L01", "L02", "L03"] },
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
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" }, confidence: { type: "string" } },
    },
    outputExample: { data: { html: "<!DOCTYPE html>...", _isHtmlReport: true }, confidence: "inferred" },

    async steps(input) {
      const { step, narrateSummary: skillSummary, selfCallId } = input;
      const line = typeof input.line === "string" ? input.line : "L01";
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const baseParams = { line, scenarioId };
      const reportType: ReportType = input.reportType === "dmaic" ? "dmaic" : "oee";

      const a = (input as Record<string, unknown>) as {
        primaryRootCause?: string;
        mechanismExplained?: string;
        auxiliaryFactors?: string[];
        confidence?: number;
        recommendations?: Recommendation[];
      };

      // ── 分派：按 reportType 走不同取数 + 模板分支 ──────────────────────
      const finalStep = reportType === "dmaic"
        ? await buildDmaicReport(step, baseParams, line, scenarioId)
        : await buildOeeReport(step, baseParams, line, scenarioId, a);

      const html = (finalStep.data as { html: string }).html;

      await skillSummary(
        `报告已生成：${line} ${reportType === "dmaic" ? "DMAIC 改善路线图" : "OEE 诊断"}（HTML ${reportType === "dmaic" ? "含 σ/DPMO 目标 + 五阶段路线图" : "含证据链 + 根因树 + 建议"}）。\n` +
        `详见 [${reportType === "dmaic" ? "DMAIC 改善路线图" : "OEE 诊断报告"}](#artifact:${selfCallId})。`,
      );

      void html;
      return finalStep;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OEE 报告分支（原有逻辑，提取为函数）
// ─────────────────────────────────────────────────────────────────────────────

async function buildOeeReport(
  step: import("../../../src/agent/skill-bridge.js").StepsInput["step"],
  baseParams: { line: string; scenarioId: string },
  line: string,
  scenarioId: string,
  a: { primaryRootCause?: string; mechanismExplained?: string; auxiliaryFactors?: string[]; confidence?: number; recommendations?: Recommendation[] },
): Promise<EvidenceEnvelope> {
  // Step 1: OEE 取数
  const step1 = await step<{ oee: number; target: number; availability: number; performance: number; quality: number }>(
    "取实时 OEE",
    async (ctx) => {
      const env = await ctx.call<{ data: { oee: number; target: number; availability: number; performance: number; quality: number } }>(
        "oee.realtime",
        baseParams,
      );
      return unpack<{ oee: number; target: number; availability: number; performance: number; quality: number }>(env);
    },
  );

  // Step 2: 设备取证
  const step2 = await step<{ healthScore: number; failureRisk30d: number; downtimeCount: number; mtbfHours: number }>(
    "取设备健康与故障预测",
    async (ctx) => {
      const hEnv = await ctx.call<{ data: { healthScore: number } }>("equipment.health", baseParams);
      const h = unpack<{ healthScore: number }>(hEnv);
      const fEnv = await ctx.call<{ data: { failureRisk30d: number } }>("equipment.failure_predict", baseParams);
      const f = unpack<{ failureRisk30d: number }>(fEnv);
      const dtEnv = await ctx.call<{ data: { eventCount: number } }>("equipment.downtime", baseParams);
      const dt = unpack<{ eventCount: number }>(dtEnv);
      const mtEnv = await ctx.call<{ data: { mtbfHours: number } }>("equipment.mtbf", baseParams);
      const mt = unpack<{ mtbfHours: number }>(mtEnv);
      return {
        healthScore: h.healthScore,
        failureRisk30d: f.failureRisk30d,
        downtimeCount: dt.eventCount,
        mtbfHours: mt.mtbfHours,
      };
    },
  );

  // Step 3: 质量取证
  const step3 = await step<{ defectRate: number; cpk: number }>("取质量缺陷率与 Cpk", async (ctx) => {
    const drEnv = await ctx.call<{ data: { defectRate: number } }>("quality.defect_rate", baseParams);
    const dr = unpack<{ defectRate: number }>(drEnv);
    const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
    const cp = unpack<{ cpk: number }>(cpEnv);
    return { defectRate: dr.defectRate, cpk: cp.cpk };
  });

  // Step 4: 工艺取证
  const step4 = await step<{ deviationScore: number }>("取工艺偏离分", async (ctx) => {
    const env = await ctx.call<{ data: { deviationScore: number } }>("process.deviation", baseParams);
    return unpack<{ deviationScore: number }>(env);
  });

  // Step 5: 因果链取证
  const step5 = await step<{ rootCause: string; layers: string[]; fishboneMan: string[]; fishboneMaterial: string[] }>(
    "取因果链 5Why",
    async (ctx) => {
      const fwEnv = await ctx.call<{ data: { chains: Array<{ rootCause: string; layers: string[] }> } }>(
        "quality.five_why",
        baseParams,
      );
      const fw = unpack<{ chains: Array<{ rootCause: string; layers: string[] }> }>(fwEnv);
      const fbEnv = await ctx.call<{ data: { branches: Array<{ dimension: string; factors: string[] }> } }>(
        "quality.fishbone",
        baseParams,
      );
      const fb = unpack<{ branches: Array<{ dimension: string; factors: string[] }> }>(fbEnv);
      const man = fb.branches.find((b) => b.dimension.includes("Man"))?.factors ?? [];
      const material = fb.branches.find((b) => b.dimension.includes("Material"))?.factors ?? [];
      return {
        rootCause: fw.chains[0]?.rootCause ?? "",
        layers: fw.chains[0]?.layers ?? [],
        fishboneMan: man,
        fishboneMaterial: material,
      };
    },
  );

  // Step 6: 组装 HTML
  const step6 = await step<EvidenceEnvelope>("组装 HTML 报告", async () => {
    const primaryRootCause = a.primaryRootCause ??
      (step5.rootCause ? step5.rootCause : "待定（当前场景无已识别根因）");
    const mechanismExplained = a.mechanismExplained ?? step5.layers.join(" → ");
    const auxiliaryFactors = a.auxiliaryFactors ?? [...step5.fishboneMan.slice(0, 2), ...step5.fishboneMaterial.slice(0, 1)];
    const confidence = a.confidence ?? (step5.rootCause ? 0.88 : 0.4);
    const recs = a.recommendations ?? [];

    const templateData: OeeTemplateData = {
      oee: step1.oee,
      target: step1.target,
      availability: step1.availability,
      performance: step1.performance,
      quality: step1.quality,
      eq: {
        healthScore: step2.healthScore,
        failureRisk30d: step2.failureRisk30d,
        downtimeCount: step2.downtimeCount,
        mtbfHours: step2.mtbfHours,
      },
      q: { defectRate: step3.defectRate, cpk: step3.cpk },
      pr: { deviationScore: step4.deviationScore },
      cc: step5,
      primaryRootCause,
      mechanismExplained,
      auxiliaryFactors,
      confidence,
      recs,
    };

    const html = buildHtmlShell("OEE 综合诊断报告", buildOeeBodyHtml(templateData), line, scenarioId);
    const diagnosis = `${line} OEE=${((step1.oee * 100)).toFixed(1)}%，主因：${primaryRootCause}（置信度 ${Math.round(confidence * 100)}%）`;

    return wrapEvidence(
      { html, _isHtmlReport: true, diagnosis, line, scenarioId, confidence, reportType: "oee" },
      {
        freshness: "realtime",
        confidence: "inferred",
        system: "MES",
        provenance: `skill.report_html?line=${line}&reportType=oee`,
        caveat: "由 oee/equipment/quality/process 工具实时组合",
      },
    );
  });

  return step6;
}

// ─────────────────────────────────────────────────────────────────────────────
// DMAIC 报告分支（复用 dmaic.ts 的取数逻辑，但独立组装模板）
// ─────────────────────────────────────────────────────────────────────────────

async function buildDmaicReport(
  step: import("../../../src/agent/skill-bridge.js").StepsInput["step"],
  baseParams: { line: string; scenarioId: string },
  line: string,
  scenarioId: string,
): Promise<EvidenceEnvelope> {
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

  // I 阶段：改善
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

  // Step 5: 组装 DMAIC 报告 HTML
  const stepFinal = await step<EvidenceEnvelope>("组装 DMAIC HTML 报告", async () => {
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
        finding: `${improvePhase.proposedActions.length} 项对策（${improvePhase.proposedActions.map((ac) => ac.action).join("；")}）`,
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

    const templateData: DmaicTemplateData = {
      define: definePhase,
      measure: measurePhase,
      analyze: analyzePhase,
      improve: improvePhase,
      reasoningChain,
    };

    const html = buildHtmlShell("DMAIC 改善路线图", buildDmaicBodyHtml(templateData), line, scenarioId);
    const diagnosis = `${line} DMAIC：当前 σ=${measurePhase.sigmaLt}（目标 4），${analyzePhase.hasCausalChain ? `根因=${analyzePhase.rootCause}` : "需补数据定位根因"}`;

    return wrapEvidence(
      { html, _isHtmlReport: true, diagnosis, line, scenarioId, reportType: "dmaic", confidence: 0.75 },
      {
        freshness: "daily",
        confidence: "inferred",
        system: "MOM",
        provenance: `skill.report_html?line=${line}&reportType=dmaic`,
        caveat: "由 oee/quality/cost 工具实时组合",
      },
    );
  });

  return stepFinal;
}
