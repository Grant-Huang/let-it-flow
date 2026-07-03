import type { StreamState } from "@meso.ai/types";

/**
 * 从 StreamState 提取 NexusOps 产物。
 *
 * NexusOps 的"产物"不是 deliver 的文稿/视频，而是：
 *  1. nexus_advise 产出的结构化建议（EvidenceEnvelope，含 recommendations）
 *  2. skill.* 产出的诊断结论（EvidenceEnvelope，含 diagnosis/confidence）
 *
 * 这些都以 tool_result（JSON 字符串）承载。本模块从 toolCalls 识别对应工具并解析。
 */
export interface ReasoningStep {
  step: number;
  action: string;
  tool: string;
  finding: string;
  inference: string;
}

export interface NexusArtifact {
  id: string;
  type: "recommendations" | "diagnosis" | "analysis_summary" | "html_report";
  title: string;
  content: string;
  ready: boolean;
  /** 推理链（skill 诊断类产物）：取数→分流→交叉验证→结论 */
  reasoningChain?: ReasoningStep[];
  /** 排除的备选解释（透明化不确定性） */
  ruledOut?: string[];
  /** 置信度 0-1 */
  confidence?: number;
}

/**
 * 从流状态提取 NexusOps 产物。
 */
export function extractArtifacts(stream: StreamState): NexusArtifact[] {
  const seen = new Map<string, NexusArtifact>();
  for (const id of stream.toolCallOrder) {
    const tc = stream.toolCalls[id];
    if (!tc) continue;
    const name = tc.call.name ?? "";

    if (name === "nexus_advise") {
      const parsed = parseAdviseOutput(tc);
      if (parsed) seen.set("nexus_advise", parsed);
      continue;
    }

    if (name === "oee.report_html" || name === "skill.report_html") {
      const parsed = parseHtmlReportOutput(tc);
      if (parsed) seen.set("report_html", parsed);
      continue;
    }

    if (name.startsWith("skill.")) {
      const parsed = parseSkillOutput(tc);
      if (parsed) seen.set(name, parsed);
      continue;
    }
  }
  return Array.from(seen.values());
}

interface ToolCallLike {
  call: { id: string; name?: string };
  result?: { output?: string } | null;
}

function parseAdviseOutput(tc: ToolCallLike): NexusArtifact | null {
  if (!tc.result) {
    return { id: tc.call.id, type: "recommendations", title: "改善建议", content: "", ready: false };
  }
  try {
    const obj = JSON.parse(tc.result.output ?? "{}") as {
      data?: { recommendations?: unknown[] };
    };
    const recs = obj.data?.recommendations;
    const count = Array.isArray(recs) ? recs.length : 0;
    return {
      id: tc.call.id,
      type: "recommendations",
      title: `改善建议（${count} 条）`,
      content: JSON.stringify(obj.data ?? {}, null, 2),
      ready: true,
    };
  } catch {
    return {
      id: tc.call.id,
      type: "recommendations",
      title: "改善建议",
      content: tc.result.output ?? "",
      ready: true,
    };
  }
}

function parseSkillOutput(tc: ToolCallLike): NexusArtifact | null {
  if (!tc.result) {
    return { id: tc.call.id, type: "diagnosis", title: "诊断结论", content: "", ready: false };
  }
  try {
    const obj = JSON.parse(tc.result.output ?? "{}") as {
      data?: {
        diagnosis?: string;
        confidence?: number;
        skillName?: string;
        reasoningChain?: ReasoningStep[];
        ruledOut?: string[];
      };
    };
    const data = obj.data ?? {};
    // 仅含 diagnosis 的 skill 进右栏；无 diagnosis 的（如纯成本汇总中间产物）不进右栏
    if (typeof data.diagnosis !== "string" || data.diagnosis.trim() === "") {
      return null;
    }
    const skillName = data.skillName ?? tc.call.name ?? "skill";
    const friendlyTitle = skillTitle(skillName);
    return {
      id: tc.call.id,
      type: "diagnosis",
      title: friendlyTitle,
      content: `${data.diagnosis}\n\n置信度：${data.confidence ?? "N/A"}`,
      ready: true,
      reasoningChain: Array.isArray(data.reasoningChain) ? data.reasoningChain : undefined,
      ruledOut: Array.isArray(data.ruledOut) ? data.ruledOut : undefined,
      confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    };
  } catch {
    return {
      id: tc.call.id,
      type: "diagnosis",
      title: "诊断结论",
      content: tc.result.output ?? "",
      ready: true,
    };
  }
}

/** 把 skill 名映射为友好的 tab 标题。 */
function skillTitle(name: string): string {
  const map: Record<string, string> = {
    "skill.oee_diagnose": "OEE 诊断",
    "skill.downtime_root_cause": "停机根因",
    "skill.multi_perspective_rca": "多视角根因",
    "skill.cost_summary": "成本汇总",
    "skill.waste_audit": "七大浪费审计",
    "skill.dmaic": "DMAIC 路线图",
    "skill.general_analysis": "综合诊断",
  };
  return map[name] ?? `${name.replace("skill.", "")} 诊断`;
}

function parseHtmlReportOutput(tc: ToolCallLike): NexusArtifact | null {
  if (!tc.result) {
    return { id: tc.call.id, type: "html_report", title: "诊断报告", content: "", ready: false };
  }
  try {
    const obj = JSON.parse(tc.result.output ?? "{}") as {
      data?: { html?: string; _isHtmlReport?: boolean; reportType?: string };
    };
    const html = obj.data?.html ?? tc.result.output ?? "";
    const title = reportTitleByType(obj.data?.reportType);
    return {
      id: tc.call.id,
      type: "html_report",
      title,
      content: html,
      ready: true,
    };
  } catch {
    return {
      id: tc.call.id,
      type: "html_report",
      title: "诊断报告",
      content: tc.result.output ?? "",
      ready: true,
    };
  }
}

/** 按 reportType 映射报告 tab 标题（与 skill.report_html 的 reportType 入参对齐）。 */
function reportTitleByType(reportType: string | undefined): string {
  if (reportType === "dmaic") return "DMAIC 改善路线图";
  return "OEE 诊断报告";
}

/** 推断展示标签 */
export function inferLabel(type: string): string {
  if (type === "recommendations") return "建议";
  if (type === "diagnosis") return "诊断";
  if (type === "analysis_summary") return "分析";
  if (type === "html_report") return "诊断报告";
  if (type === "pending") return "分析中…";
  return "产物";
}

/** 推断 ArtifactPanel type */
export function inferArtifactType(_type: string): "markdown" | "code" {
  return "code";
}

/** Whether an artifact should render as an iframe (HTML report). */
export function isHtmlArtifact(type: string): boolean {
  return type === "html_report";
}
