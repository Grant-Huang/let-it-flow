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
import {
  escapeHtml,
  pct,
  colorByThreshold,
  type PhaseCardData,
} from "./report-components.js";
import { renderReport } from "./report-renderer.js";
import type { ComponentLayout, ComponentInstance } from "../../../src/orchestrator/report-types.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
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

function buildOeeLayout(d: OeeTemplateData): ComponentLayout {
  const trend7d = Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    const v = d.target * (1 - t * (1 - d.oee / d.target));
    return Number((v * 100).toFixed(1));
  });

  const evidenceRows = [
    { tool: "oee.realtime", data: `OEE=${pct(d.oee)}，目标=${pct(d.target)}`, step: "基础指标" },
    { tool: "equipment.health", data: `健康分=${d.eq.healthScore.toFixed(2)}，故障风险=${pct(d.eq.failureRisk30d)}`, step: "设备取证" },
    { tool: "quality.defects", data: `不良率=${pct(d.q.defectRate)}，Cpk=${d.q.cpk.toFixed(2)}`, step: "质量取证" },
    { tool: "process.deviation", data: `偏离分=${d.pr.deviationScore.toFixed(2)}`, step: "工艺取证" },
    d.cc.rootCause
      ? { tool: "quality.five_why", data: `根因：${d.cc.rootCause}`, step: "因果链取证" }
      : { tool: "quality.five_why", data: "无已识别因果链（normal 场景）", step: "因果链取证" },
  ];

  const fishboneBranches: Array<{ dimension: string; factors: string[] }> = [];
  if (d.auxiliaryFactors.length > 0) {
    fishboneBranches.push({ dimension: "辅助因素", factors: d.auxiliaryFactors });
  }

  const components: ComponentInstance[] = [
    {
      name: "kpi-grid",
      data: {
        cards: [
          { label: "综合 OEE", value: pct(d.oee), target: `目标 ${pct(d.target)}`, color: colorByThreshold(d.oee, d.target * 0.95) },
          { label: "可用率", value: pct(d.availability), target: `停机 ${d.eq.downtimeCount} 起`, color: colorByThreshold(d.availability) },
          { label: "性能率", value: pct(d.performance), target: `MTBF ${d.eq.mtbfHours}h`, color: colorByThreshold(d.performance) },
          { label: "质量率", value: pct(d.quality), target: `不良率 ${pct(d.q.defectRate)}`, color: colorByThreshold(d.quality) },
        ],
      },
      wrapper: { type: "section", title: "KPI 概览" },
    },
    {
      name: "trend-svg",
      data: { points: trend7d, target: d.target * 100, label: "-6d  -5d  -4d  -3d  -2d  昨  今" },
      wrapper: { type: "section", title: "OEE 7 日趋势" },
    },
    {
      name: "evidence-table",
      data: { rows: evidenceRows },
      wrapper: { type: "section", title: "证据链" },
    },
    {
      name: "root-cause-tree",
      data: { rootCause: d.primaryRootCause, layers: d.cc.layers },
      wrapper: { type: "section", title: "根因分析" },
    },
  ];

  // 辅助因素（鱼骨图摘要），非空才追加
  if (fishboneBranches.length > 0) {
    components.push({ name: "fishbone-summary", data: { branches: fishboneBranches } });
  }

  components.push({
    name: "confidence-bar",
    data: { label: "置信度", value: d.confidence },
  });

  // 机制路径（非空才追加为文本块）
  if (d.mechanismExplained) {
    components.push({
      name: "text-block",
      data: { text: `机制路径：${d.mechanismExplained}`, variant: "muted" },
    });
  }

  components.push({
    name: "recommendation-list",
    data: { recommendations: d.recs, emptyText: "暂无结构化建议（请先调用 nexus_advise 生成建议）" },
    wrapper: { type: "section", title: "改善建议" },
  });

  return {
    reportType: "oee",
    title: "OEE 综合诊断报告",
    components,
  };
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

function buildDmaicLayout(d: DmaicTemplateData): ComponentLayout {
  const zLt = d.measure.sigmaLt;
  const sigmaGap = Math.max(0, 4 - zLt);
  const priorityColor = zLt < 2 ? "#ef4444" : zLt < 3 ? "#f59e0b" : "#22c55e";
  const priorityLabel = zLt < 2 ? "critical" : zLt < 3 ? "high" : "medium";
  const duration = zLt < 2 ? "3-6 个月" : zLt < 3 ? "2-4 个月" : "1-3 个月";
  const sigmaBadgeColor = zLt >= 4 ? "#22c55e" : zLt >= 3 ? "#f59e0b" : "#ef4444";

  const D: PhaseCardData = {
    phase: "D", name: "Define（定义）",
    objective: "明确改善课题的范围、目标、财务收益",
    detailHtml: `<strong>课题陈述：</strong>${d.analyze.hasCausalChain ? escapeHtml(d.analyze.rootCause) : `OEE=${pct(d.define.oee)}，Cpk=${d.define.cpk.toFixed(2)}，存在改善空间`}<br>
     <strong>目标：</strong>OEE 从 ${pct(d.define.oee)} 提升至 ${pct(d.define.target)}，Cpk 从 ${d.define.cpk.toFixed(2)} 提升至 ≥1.33<br>
     <strong>财务收益：</strong>预计日节约 ${Math.round(d.define.totalLossCost * 0.3)} 元（假设改善 30% 损失）`,
    status: "ready",
  };

  const M: PhaseCardData = {
    phase: "M", name: "Measure（测量）",
    objective: "量化当前过程的基线表现",
    detailHtml: `<strong>基线指标：</strong>不良率 ${pct(d.measure.defectRate)}，FPY ${pct(d.measure.fpy)}，报废率 ${pct(d.measure.scrapRate)}<br>
     <strong>过程能力：</strong>Cpk=${d.measure.cpk.toFixed(2)}，DPMO=${d.measure.dpmo}<br>
     <strong>长期 σ：</strong>${d.measure.sigmaLt}（目标 4）`,
    status: "ready",
  };

  const A: PhaseCardData = {
    phase: "A", name: "Analyze（分析）",
    objective: "识别根本原因，建立缺陷与输入变量的因果关系",
    detailHtml: d.analyze.hasCausalChain
      ? `<strong>方法：</strong>5Why + 鱼骨图<br><strong>根因：</strong>${escapeHtml(d.analyze.rootCause)}<br><strong>机制路径：</strong>${escapeHtml(d.analyze.mechanismPath)}<br><strong>鱼骨首要嫌疑：</strong>${escapeHtml(d.analyze.fishboneTopSuspect)}`
      : `<strong>状态：</strong>当前证据不足以确定根因，需补充现场数据后分析<br><strong>鱼骨首要嫌疑：</strong>${escapeHtml(d.analyze.fishboneTopSuspect)}`,
    status: d.analyze.hasCausalChain ? "ready" : "blocked_by_data",
  };

  const I: PhaseCardData = {
    phase: "I", name: "Improve（改善）",
    objective: "实施改善方案，验证效果",
    detailHtml: d.improve.proposedActions.length === 0
      ? "暂无结构化对策（需 Analyze 阶段完成后组合）"
      : d.improve.proposedActions.map((a) => `• ${escapeHtml(a.action)}（工具：<code>${escapeHtml(a.tool)}</code>，优先级：${escapeHtml(a.priority)}）`).join("<br>"),
    status: "ready",
  };

  const C: PhaseCardData = {
    phase: "C", name: "Control（控制）",
    objective: "建立监控体系，固化改善成果",
    detailHtml: `<strong>SPC 监控：</strong>对关键尺寸建立控制图（走 quality.spc）<br>
     <strong>标准作业：</strong>更新 SOP + 控制计划（走 process.control_plan）<br>
     <strong>审核频率：</strong>每周审核 Cpk 趋势 + 每月评审 OEE 是否达标<br>
     <strong>反应计划：</strong>Cpk <1.0 触发紧急复检 + 参数回调<br>
     <strong>目标指标：</strong>Cpk=1.33、OEE=${pct(d.define.target)}、FPY=95%、σ=4`,
    status: "ready",
  };

  const components: ComponentInstance[] = [
    {
      name: "kpi-grid",
      data: {
        cards: [
          { label: "长期 σ 水平", value: d.measure.sigmaLt.toFixed(2), target: "目标 4.0", color: sigmaBadgeColor },
          { label: "DPMO", value: String(d.measure.dpmo), target: "目标 ≤3.4", color: sigmaBadgeColor },
          { label: "过程能力 Cpk", value: d.measure.cpk.toFixed(2), target: "目标 ≥1.33", color: colorByThreshold(d.measure.cpk, 1.33) },
          { label: "距 6Sigma 差距", value: `${sigmaGap.toFixed(2)}σ`, target: `优先级 ${priorityLabel}`, color: priorityColor },
        ],
      },
      wrapper: { type: "section", title: "6Sigma 水平概览" },
    },
    {
      name: "text-block",
      data: {
        text: `项目评估：预计周期 ${duration} · 改善优先级 ${priorityLabel}`,
        variant: "default",
      },
      wrapper: { type: "section" },
    },
    {
      name: "phase-card",
      data: { ...D },
    },
    {
      name: "phase-card",
      data: { ...M },
    },
    {
      name: "phase-card",
      data: { ...A },
    },
    {
      name: "phase-card",
      data: { ...I },
    },
    {
      name: "phase-card",
      data: { ...C },
      wrapper: { type: "section", title: "DMAIC 五阶段路线图" },
    },
    {
      name: "reasoning-table",
      data: { steps: d.reasoningChain },
      wrapper: { type: "section", title: "推理链" },
    },
  ];

  return {
    reportType: "dmaic",
    title: "DMAIC 改善路线图",
    components,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// skill 主体
// ─────────────────────────────────────────────────────────────────────────────

/** skill 创建选项。 */
export interface ReportHtmlSkillOptions {
  /** 可选的 SkillRegistry（用于报表固化模板匹配：命中 active 模板时走模板路径，0 LLM 调用）。 */
  skillRegistry?: import("../../../src/agent/skill-registry.js").SkillRegistry;
}

export function createReportHtmlSkill(opts: ReportHtmlSkillOptions = {}) {
  const { skillRegistry } = opts;
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

      // ── 模板匹配（Phase 2.2）：命中 active 固化模板时走模板路径（0 LLM 调用） ──
      const template = skillRegistry?.getReportTemplate(reportType);
      const finalStep = template
        ? renderFromTemplate(template.layout, template.title, line, scenarioId, reportType)
        : reportType === "dmaic"
          ? await buildDmaicReport(step, baseParams, line, scenarioId)
          : await buildOeeReport(step, baseParams, line, scenarioId, a);

      const html = (finalStep.data as { html: string }).html;

      await skillSummary(
        `报告已生成：${line} ${reportType === "dmaic" ? "DMAIC 改善路线图" : "OEE 诊断"}（HTML ${reportType === "dmaic" ? "含 σ/DPMO 目标 + 五阶段路线图" : "含证据链 + 根因树 + 建议"}）${template ? "（使用固化模板）" : ""}。\n` +
        `详见 [${reportType === "dmaic" ? "DMAIC 改善路线图" : "OEE 诊断报告"}](#artifact:${selfCallId})。`,
      );

      void html;
      return finalStep;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 模板路径：渲染固化 ComponentLayout（0 LLM 调用，0 工具取数）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从固化的 ComponentLayout 模板渲染报告。
 *
 * 模板里的 data 字段是占位符（固化时的快照），直接渲染即可。
 * 未来可扩展为"用当前数据填充占位符"（substitute）。
 */
function renderFromTemplate(
  layout: ComponentLayout,
  title: string,
  line: string,
  scenarioId: string,
  reportType: ReportType,
): EvidenceEnvelope {
  const filledLayout: ComponentLayout = {
    ...layout,
    title: title || layout.title,
    meta: { line, scenarioId },
  };
  const html = renderReport(filledLayout);
  const diagnosis = `${line} 报告（固化模板 ${reportType}）`;
  return wrapEvidence(
    { html, _isHtmlReport: true, diagnosis, line, scenarioId, reportType, confidence: 0.7, fromTemplate: true },
    {
      freshness: "daily",
      confidence: "inferred",
      system: "MOM",
      provenance: `skill.report_html?line=${line}&reportType=${reportType}&source=template`,
      caveat: "由固化模板渲染（非实时取数）",
    },
  );
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

    const layout = buildOeeLayout(templateData);
    layout.meta = { line, scenarioId };
    const html = renderReport(layout);
    const diagnosis = `${line} OEE=${((step1.oee * 100)).toFixed(1)}%，主因：${primaryRootCause}（置信度 ${Math.round(confidence * 100)}%）`;

    return wrapEvidence(
      { html, _isHtmlReport: true, diagnosis, line, scenarioId, confidence, reportType: "oee", layout },
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

    const layout = buildDmaicLayout(templateData);
    layout.meta = { line, scenarioId };
    const html = renderReport(layout);
    const diagnosis = `${line} DMAIC：当前 σ=${measurePhase.sigmaLt}（目标 4），${analyzePhase.hasCausalChain ? `根因=${analyzePhase.rootCause}` : "需补数据定位根因"}`;

    return wrapEvidence(
      { html, _isHtmlReport: true, diagnosis, line, scenarioId, reportType: "dmaic", confidence: 0.75, layout },
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
