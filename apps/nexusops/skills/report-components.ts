/**
 * 报表组件库（L3 报表系统 —— 组件层）。
 *
 * 设计见 apps/nexusops/docs/architecture/03-report-system-design.md §3。
 *
 * 核心原则（D7）：组件是纯函数，输入 data → 输出 HTML 片段。
 *   - 不调外部 API，不读运行时状态（保证可测试）
 *   - 不内联 <script>（所有交互通过 action-button 的 postMessage 协议）
 *   - 所有用户数据经 escapeHtml 转义
 *
 * 从 report-html.ts 的 SHARED_CSS 和模板片段提取。
 */
import type { ReportComponent } from "../../../src/orchestrator/report-types.js";

/** HTML 转义（防 XSS）。 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 数值转百分比字符串。 */
export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** 颜色阈值辅助（绿/黄/红）。 */
export function colorByThreshold(v: number, threshold = 0.8): string {
  return v >= threshold ? "#22c55e" : v >= 0.65 ? "#f59e0b" : "#ef4444";
}

/** 共享 CSS（所有组件 + 渲染器复用）。从 report-html.ts 的 SHARED_CSS 提取。 */
export const REPORT_CSS = `
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
  .score-card { background: #0f172a; border-radius: 8px; padding: 16px; text-align: center; border: 1px solid #334155; }
  .score-value { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .score-label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .dim-table { width: 100%; }
  .dim-table td:first-child { font-weight: 600; color: #f1f5f9; }
  .error-box { background: #451a03; border-radius: 8px; padding: 12px; color: #fb923c; font-size: 13px; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// 组件数据类型
// ─────────────────────────────────────────────────────────────────────────────

export interface KpiCardData {
  label: string;
  value: string;
  target?: string;
  color?: string;
}

export interface KpiGridData {
  cards: KpiCardData[];
}

export interface TrendSvgData {
  points: number[];
  target?: number;
  label?: string;
}

export interface EvidenceTableData {
  rows: Array<{ tool: string; data: string; step: string }>;
  title?: string;
}

export interface RootCauseTreeData {
  rootCause: string;
  layers: string[];
}

export interface FishboneSummaryData {
  branches: Array<{ dimension: string; factors: string[] }>;
}

export interface ConfidenceBarData {
  label: string;
  value: number;
  color?: string;
}

export interface RecommendationCardData {
  index?: number;
  title?: string;
  rationale?: string;
  impact?: number;
  executionScore?: number;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
}

export interface RecommendationListData {
  recommendations: RecommendationCardData[];
  emptyText?: string;
}

export interface PhaseCardData {
  phase: string;
  name: string;
  objective: string;
  detailHtml: string;
  status: "ready" | "blocked_by_data";
}

export interface ReasoningTableData {
  steps: Array<{ step?: number; action?: string; tool: string; finding: string; inference: string }>;
  title?: string;
}

export interface ActionButtonData {
  tool: string;
  args?: Record<string, unknown>;
  label: string;
}

export interface SectionData {
  title?: string;
  innerHtml: string;
}

export interface TextBlockData {
  text: string;
  variant?: "default" | "muted" | "warn";
}

export interface ScoreCardData {
  value: number;
  label: string;
  max?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件实现
// ─────────────────────────────────────────────────────────────────────────────

/** KPI 卡片组件。 */
export const kpiCard: ReportComponent<KpiCardData> = {
  name: "kpi-card",
  description: "单个 KPI 指标卡片，含数值、标签、目标值、颜色阈值。",
  dataSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "string" },
      target: { type: "string" },
      color: { type: "string", description: "CSS 颜色值" },
    },
    required: ["label", "value"],
  },
  render: (d) => `
    <div class="kpi-card">
      <div class="kpi-label">${escapeHtml(d.label)}</div>
      <div class="kpi-value" style="color:${d.color ?? "#e2e8f0"}">${escapeHtml(d.value)}</div>
      ${d.target ? `<div class="kpi-target">${escapeHtml(d.target)}</div>` : ""}
    </div>`,
};

/** KPI 网格容器。 */
export const kpiGrid: ReportComponent<KpiGridData> = {
  name: "kpi-grid",
  description: "KPI 网格容器，包装多个 kpi-card。",
  dataSchema: {
    type: "object",
    properties: {
      cards: { type: "array", items: { type: "object" } },
    },
    required: ["cards"],
  },
  render: (d) => `
    <div class="kpi-grid">
      ${d.cards.map((c) => kpiCard.render(c)).join("\n")}
    </div>`,
};

/** SVG 趋势折线图。 */
export const trendSvg: ReportComponent<TrendSvgData> = {
  name: "trend-svg",
  description: "SVG 趋势折线图，展示时序数据。",
  dataSchema: {
    type: "object",
    properties: {
      points: { type: "array", items: { type: "number" } },
      target: { type: "number" },
      label: { type: "string" },
    },
    required: ["points"],
  },
  render: (d) => {
    const n = d.points.length;
    if (n === 0) return '<div class="error-box">无趋势数据</div>';
    const max = Math.max(...d.points, d.target ?? 0);
    const svgPoints = d.points
      .map((v, i) => `${(i / Math.max(n - 1, 1)) * 220},${80 - (v / Math.max(max, 1)) * 70}`)
      .join(" ");
    const targetLine = d.target != null
      ? `<line x1="0" y1="${80 - (d.target / Math.max(max, 1)) * 70}" x2="240" y2="${80 - (d.target / Math.max(max, 1)) * 70}" stroke="#334155" stroke-width="1" stroke-dasharray="4 3"/>`
      : "";
    return `
    <svg class="trend-svg" viewBox="0 0 240 90" preserveAspectRatio="none">
      <defs>
        <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${targetLine}
      <polyline points="${svgPoints}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="220" cy="${80 - (d.points[n - 1]! / Math.max(max, 1)) * 70}" r="3" fill="#3b82f6"/>
    </svg>
    ${d.label ? `<div style="font-size:10px;color:#475569;margin-top:4px">${escapeHtml(d.label)}</div>` : ""}`;
  },
};

/** 证据链表格。 */
export const evidenceTable: ReportComponent<EvidenceTableData> = {
  name: "evidence-table",
  description: "证据链表格（工具 + 数据 + 步骤）。",
  dataSchema: {
    type: "object",
    properties: {
      rows: { type: "array" },
      title: { type: "string" },
    },
    required: ["rows"],
  },
  render: (d) => `
    <table>
      <thead><tr><th>工具</th><th>关键数据</th><th>推理步骤</th></tr></thead>
      <tbody>
        ${d.rows.map((r) => `
        <tr>
          <td><span class="badge badge-tool">${escapeHtml(r.tool)}</span></td>
          <td style="color:#cbd5e1">${escapeHtml(r.data)}</td>
          <td style="color:#64748b">${escapeHtml(r.step)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`,
};

/** 根因树。 */
export const rootCauseTree: ReportComponent<RootCauseTreeData> = {
  name: "root-cause-tree",
  description: "根因树（根因 + 5Why 层级）。",
  dataSchema: {
    type: "object",
    properties: {
      rootCause: { type: "string" },
      layers: { type: "array", items: { type: "string" } },
    },
    required: ["rootCause", "layers"],
  },
  render: (d) => `
    <div class="tree">
      <div class="tree-root">根因：${escapeHtml(d.rootCause)}</div>
      ${d.layers.map((layer, i) => `<div class="tree-layer" style="padding-left:${(i + 1) * 18}px">${escapeHtml(layer)}</div>`).join("")}
    </div>`,
};

/** 鱼骨图摘要。 */
export const fishboneSummary: ReportComponent<FishboneSummaryData> = {
  name: "fishbone-summary",
  description: "鱼骨图摘要（5M1E 分支标签）。",
  dataSchema: {
    type: "object",
    properties: {
      branches: { type: "array" },
    },
    required: ["branches"],
  },
  render: (d) => {
    const nonEmpty = d.branches.filter((b) => b.factors.length > 0);
    if (nonEmpty.length === 0) return '<div style="color:#64748b;font-size:12px">无显著异常因素（normal 场景）</div>';
    return nonEmpty.map((b) => `
      <div style="margin-bottom:8px">
        <div style="font-size:12px;color:#64748b;margin-bottom:4px">${escapeHtml(b.dimension)}</div>
        <div class="aux-list">
          ${b.factors.map((f) => `<span class="aux-tag">${escapeHtml(f)}</span>`).join("")}
        </div>
      </div>`).join("");
  },
};

/** 置信度进度条。 */
export const confidenceBar: ReportComponent<ConfidenceBarData> = {
  name: "confidence-bar",
  description: "置信度进度条。",
  dataSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "number" },
      color: { type: "string" },
    },
    required: ["label", "value"],
  },
  render: (d) => {
    const c = d.color ?? (d.value > 0.7 ? "#22c55e" : d.value > 0.5 ? "#f59e0b" : "#ef4444");
    return `
      <div class="confidence-bar">
        <span class="conf-label">${escapeHtml(d.label)}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(d.value * 100)}%;background:${c}"></div></div>
        <span class="conf-val">${Math.round(d.value * 100)}%</span>
      </div>`;
  },
};

/** 建议卡片（含可执行按钮）。 */
export const recommendationCard: ReportComponent<RecommendationCardData> = {
  name: "recommendation-card",
  description: "单个建议卡片，含影响度/执行度进度条和可选执行按钮。",
  dataSchema: {
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
  render: (d) => {
    const hasAction = typeof d.actionTool === "string" && d.actionTool;
    const argsJson = d.actionArgs ? JSON.stringify(d.actionArgs).replace(/"/g, "&quot;") : "{}";
    const impactPct = Math.round((d.impact ?? 0) * 100);
    const execPct = Math.round((d.executionScore ?? 0) * 100);
    return `
      <div class="rec-card">
        <div class="rec-header">
          ${d.index != null ? `<span class="rec-idx">#${d.index}</span>` : ""}
          <span class="rec-title">${escapeHtml(d.title ?? "建议")}</span>
          ${hasAction ? `<span class="badge badge-action">可执行</span>` : ""}
        </div>
        <div class="rec-rationale">${escapeHtml(d.rationale ?? "")}</div>
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
        <button class="action-btn" onclick="window.parent.postMessage({type:'nexus_mcp',tool:'${escapeHtml(d.actionTool!)}',args:${argsJson}},'*')">
          ▶ 执行：${escapeHtml(d.actionTool ?? "")}
        </button>`
          : ""}
      </div>`;
  },
};

/** 建议列表（包装多个 recommendation-card）。 */
export const recommendationList: ReportComponent<RecommendationListData> = {
  name: "recommendation-list",
  description: "建议列表容器，包装多个 recommendation-card。",
  dataSchema: {
    type: "object",
    properties: {
      recommendations: { type: "array" },
      emptyText: { type: "string" },
    },
    required: ["recommendations"],
  },
  render: (d) => {
    if (d.recommendations.length === 0) {
      return `<p style="color:#6b7280;font-size:13px;">${escapeHtml(d.emptyText ?? "暂无结构化建议")}</p>`;
    }
    return d.recommendations
      .map((rec, i) => recommendationCard.render({ ...rec, index: i + 1 }))
      .join("\n");
  },
};

/** 阶段卡片（DMAIC 等用）。 */
export const phaseCard: ReportComponent<PhaseCardData> = {
  name: "phase-card",
  description: "方法论阶段卡片（DMAIC D/M/A/I/C 等），含阶段标识、目标、详情、状态。",
  dataSchema: {
    type: "object",
    properties: {
      phase: { type: "string" },
      name: { type: "string" },
      objective: { type: "string" },
      detailHtml: { type: "string" },
      status: { type: "string", enum: ["ready", "blocked_by_data"] },
    },
    required: ["phase", "name", "objective", "detailHtml", "status"],
  },
  render: (d) => {
    const statusBadge = `<span class="badge badge-status-${d.status === "ready" ? "ready" : "blocked"}">${d.status === "ready" ? "就绪" : "阻塞（待数据）"}</span>`;
    return `
      <div class="phase-card">
        <div class="phase-header">
          <span class="badge badge-phase">${escapeHtml(d.phase)}</span>
          <span class="phase-name">${escapeHtml(d.name)}</span>
          ${statusBadge}
        </div>
        <div class="phase-objective">${escapeHtml(d.objective)}</div>
        <div class="phase-detail">${d.detailHtml}</div>
      </div>`;
  },
};

/** 推理链表格。 */
export const reasoningTable: ReportComponent<ReasoningTableData> = {
  name: "reasoning-table",
  description: "推理链表格（工具 + 关键发现 + 阶段推理）。",
  dataSchema: {
    type: "object",
    properties: {
      steps: { type: "array" },
      title: { type: "string" },
    },
    required: ["steps"],
  },
  render: (d) => `
    <table>
      <thead><tr><th>工具</th><th>关键发现</th><th>阶段推理</th></tr></thead>
      <tbody>
        ${d.steps.map((r) => `
        <tr>
          <td><span class="badge badge-tool">${escapeHtml(r.tool)}</span></td>
          <td style="color:#cbd5e1">${escapeHtml(r.finding)}</td>
          <td style="color:#94a3b8">${escapeHtml(r.inference)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`,
};

/** 可执行按钮（触发 postMessage）。 */
export const actionButton: ReportComponent<ActionButtonData> = {
  name: "action-button",
  description: "可执行按钮，点击触发 postMessage 给父窗口（HITL 确认）。",
  dataSchema: {
    type: "object",
    properties: {
      tool: { type: "string" },
      args: { type: "object" },
      label: { type: "string" },
    },
    required: ["tool", "label"],
  },
  render: (d) => {
    const argsJson = d.args ? JSON.stringify(d.args).replace(/"/g, "&quot;") : "{}";
    return `<button class="action-btn" onclick="window.parent.postMessage({type:'nexus_mcp',tool:'${escapeHtml(d.tool)}',args:${argsJson}},'*')">${escapeHtml(d.label)}</button>`;
  },
};

/** 通用 section 容器（带标题）。 */
export const section: ReportComponent<SectionData> = {
  name: "section",
  description: "通用 section 容器，带可选标题，包装内部 HTML。",
  dataSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      innerHtml: { type: "string" },
    },
    required: ["innerHtml"],
  },
  render: (d) => `
    <div class="section">
      ${d.title ? `<h3>${escapeHtml(d.title)}</h3>` : ""}
      ${d.innerHtml}
    </div>`,
};

/** 通用文本块。 */
export const textBlock: ReportComponent<TextBlockData> = {
  name: "text-block",
  description: "通用文本块，支持 default/muted/warn 变体。",
  dataSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      variant: { type: "string", enum: ["default", "muted", "warn"] },
    },
    required: ["text"],
  },
  render: (d) => {
    const color = d.variant === "muted" ? "#64748b" : d.variant === "warn" ? "#fb923c" : "#cbd5e1";
    return `<p style="color:${color};font-size:13px;">${escapeHtml(d.text)}</p>`;
  },
};

/** 评分卡片（质量评估器用）。 */
export const scoreCard: ReportComponent<ScoreCardData> = {
  name: "score-card",
  description: "评分卡片，展示 0-10 分数值（质量评估器用）。",
  dataSchema: {
    type: "object",
    properties: {
      value: { type: "number" },
      label: { type: "string" },
      max: { type: "number" },
    },
    required: ["value", "label"],
  },
  render: (d) => {
    const max = d.max ?? 10;
    const color = d.value >= max * 0.8 ? "#22c55e" : d.value >= max * 0.6 ? "#f59e0b" : "#ef4444";
    return `
      <div class="score-card">
        <div class="score-value" style="color:${color}">${d.value.toFixed(1)}</div>
        <div class="score-label">${escapeHtml(d.label)}</div>
        <div class="kpi-target">满分 ${max}</div>
      </div>`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 组件注册表
// ─────────────────────────────────────────────────────────────────────────────

/** 组件注册表（name → component）。 */
export const REPORT_COMPONENTS: Record<string, ReportComponent> = {
  "kpi-card": kpiCard,
  "kpi-grid": kpiGrid,
  "trend-svg": trendSvg,
  "evidence-table": evidenceTable,
  "root-cause-tree": rootCauseTree,
  "fishbone-summary": fishboneSummary,
  "confidence-bar": confidenceBar,
  "recommendation-card": recommendationCard,
  "recommendation-list": recommendationList,
  "phase-card": phaseCard,
  "reasoning-table": reasoningTable,
  "action-button": actionButton,
  section,
  "text-block": textBlock,
  "score-card": scoreCard,
};

/** 获取组件清单（给 LLM 看的"组件说明书"）。 */
export function getComponentManifest(): Array<{ name: string; description: string; dataSchema: Record<string, unknown> }> {
  return Object.values(REPORT_COMPONENTS).map((c) => ({
    name: c.name,
    description: c.description,
    dataSchema: c.dataSchema,
  }));
}
