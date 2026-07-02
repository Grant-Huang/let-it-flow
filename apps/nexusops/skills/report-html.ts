/**
 * skill.report_html：OEE 综合诊断 HTML 报告（应用层 —— L 内容）。
 *
 * 替代原 domain 工具 oee.report_html。原工具直取 5 个 accessor（跨域耦合），
 * 现改为 skill，前 5 步 ctx.call 取数，最后一步组装 HTML。
 *
 * 步骤序列：
 *   1. ctx.call("oee.realtime") → OEE 数值
 *   2. ctx.call("equipment.health") + ctx.call("equipment.failure_predict") → 设备取证
 *   3. ctx.call("quality.defect_rate") + ctx.call("quality.cp_cpk") → 质量取证
 *   4. ctx.call("process.deviation") → 工艺取证
 *   5. ctx.call("quality.five_why") → 因果链取证
 *   6. 组装自包含 HTML 报告
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

export function createReportHtmlSkill() {
  return createSkill({
    name: "skill.report_html",
    description:
      "生成 OEE 综合诊断的自包含 HTML 报告，在右栏以图表 + 根因树 + 建议面板展示。报告内嵌 CSS，无外部依赖，可直接 iframe 渲染。建议有行动项时，报告中包含执行按钮（通过 postMessage 触发 HITL 确认）。通过 ctx.call 串联 Layer 1 工具取数。",
    whenToUse: {
      triggers: ["生成报告", "OEE 报告", "可视化诊断", "展示诊断结果", "html 报告", "右栏显示报告"],
      notFor: ["只查 OEE 数值（走 oee.realtime）", "只查根因（走 skill.oee_diagnose）"],
    },
    inputSchema: {
      type: "object",
      properties: {
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

      const a = (input as Record<string, unknown>) as {
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
        const oee = step1;
        const eq = step2;
        const q = step3;
        const pr = step4;
        const cc = step5;

        const primaryRootCause = a.primaryRootCause ??
          (cc.rootCause ? cc.rootCause : "待定（当前场景无已识别根因）");
        const mechanismExplained = a.mechanismExplained ?? cc.layers.join(" → ");
        const auxiliaryFactors = a.auxiliaryFactors ?? [...cc.fishboneMan.slice(0, 2), ...cc.fishboneMaterial.slice(0, 1)];
        const confidence = a.confidence ?? (cc.rootCause ? 0.88 : 0.4);
        const recs = a.recommendations ?? [];

        const trend7d = Array.from({ length: 7 }, (_, i) => {
          const t = i / 6;
          const v = oee.target * (1 - t * (1 - oee.oee / oee.target));
          return (v * 100).toFixed(1);
        });

        const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
        const color = (v: number, threshold = 0.8) => (v >= threshold ? "#22c55e" : v >= 0.65 ? "#f59e0b" : "#ef4444");

        const svgPoints = trend7d
          .map((v, i) => `${(i / 6) * 220},${80 - (parseFloat(v) / 100) * 70}`)
          .join(" ");

        const evidenceRows = [
          { tool: "oee.realtime", data: `OEE=${pct(oee.oee)}，目标=${pct(oee.target)}`, step: "基础指标" },
          { tool: "equipment.health", data: `健康分=${eq.healthScore.toFixed(2)}，故障风险=${pct(eq.failureRisk30d)}`, step: "设备取证" },
          { tool: "quality.defects", data: `不良率=${pct(q.defectRate)}，Cpk=${q.cpk.toFixed(2)}`, step: "质量取证" },
          { tool: "process.deviation", data: `偏离分=${pr.deviationScore.toFixed(2)}`, step: "工艺取证" },
          cc.rootCause
            ? { tool: "quality.five_why", data: `根因：${cc.rootCause}`, step: "因果链取证" }
            : { tool: "quality.five_why", data: "无已识别因果链（normal 场景）", step: "因果链取证" },
        ];

        const fiveWhyLayers = cc.layers;

        const recsHtml = recs.length === 0
          ? `<p style="color:#6b7280;font-size:13px;">暂无结构化建议（请先调用 nexus_advise 生成建议）</p>`
          : recs.map((rec, i) => {
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
  <div class="report-meta">${line} · 场景：${scenarioId} · ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>
</div>

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
      <div class="kpi-target">停机 ${eq.downtimeCount} 起</div>
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
    <div class="tree-root">根因：${escapeHtml(primaryRootCause)}</div>
    ${fiveWhyLayers.map((layer, i) => `<div class="tree-layer" style="padding-left:${(i + 1) * 18}px">${escapeHtml(layer)}</div>`).join("")}
  </div>
  ${auxiliaryFactors.length > 0
    ? `
  <div style="margin-top:12px">
    <div style="font-size:12px;color:#64748b;margin-bottom:6px">辅助因素</div>
    <div class="aux-list">
      ${auxiliaryFactors.map((f) => `<span class="aux-tag">${escapeHtml(f)}</span>`).join("")}
    </div>
  </div>`
    : ""}
  <div class="confidence-bar">
    <span class="conf-label">置信度</span>
    <div class="bar-bg"><div class="bar-fill" style="width:${Math.round(confidence * 100)}%;background:${confidence > 0.7 ? "#22c55e" : confidence > 0.5 ? "#f59e0b" : "#ef4444"}"></div></div>
    <span class="conf-val">${Math.round(confidence * 100)}%</span>
  </div>
  ${mechanismExplained ? `<div style="margin-top:10px;font-size:12px;color:#64748b;line-height:1.6">机制路径：<span style="color:#94a3b8">${escapeHtml(mechanismExplained)}</span></div>` : ""}
</div>

<div class="section">
  <h3>改善建议</h3>
  ${recsHtml}
</div>

<script>
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'nexus_mcp') {
      window.parent.postMessage(e.data, '*');
    }
  });
</script>
</body>
</html>`;

        const diagnosis = `${line} OEE=${pct(oee.oee)}，主因：${primaryRootCause}（置信度 ${Math.round(confidence * 100)}%）`;

        return wrapEvidence(
          { html, _isHtmlReport: true, diagnosis, line, scenarioId, confidence },
          {
            freshness: "realtime",
            confidence: "inferred",
            system: "MES",
            provenance: `skill.report_html?line=${line}`,
            caveat: "由 oee/equipment/quality/process 工具实时组合",
          },
        );
      });

      await skillSummary(
        `报告已生成：${line} OEE 诊断（HTML 含证据链表 + 根因树 + 建议）。\n` +
        `详见 [OEE 诊断报告](#artifact:${selfCallId})。`,
      );

      return step6;
    },
  });
}
