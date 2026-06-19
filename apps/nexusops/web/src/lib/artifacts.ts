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
export interface NexusArtifact {
  id: string;
  type: "recommendations" | "diagnosis" | "analysis_summary";
  title: string;
  content: string;
  ready: boolean;
}

/**
 * 从流状态提取 NexusOps 产物。
 */
export function extractArtifacts(stream: StreamState): NexusArtifact[] {
  const out: NexusArtifact[] = [];
  for (const id of stream.toolCallOrder) {
    const tc = stream.toolCalls[id];
    if (!tc) continue;
    const name = tc.call.name ?? "";

    if (name === "nexus_advise") {
      const parsed = parseAdviseOutput(tc);
      if (parsed) out.push(parsed);
      continue;
    }

    if (name.startsWith("skill.")) {
      const parsed = parseSkillOutput(tc);
      if (parsed) out.push(parsed);
      continue;
    }
  }
  return out;
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
      data?: { diagnosis?: string; confidence?: number; skillName?: string };
    };
    const data = obj.data ?? {};
    const skillName = data.skillName ?? tc.call.name ?? "skill";
    return {
      id: tc.call.id,
      type: "diagnosis",
      title: `${skillName} 诊断结论`,
      content:
        typeof data.diagnosis === "string"
          ? `${data.diagnosis}\n\n置信度：${data.confidence ?? "N/A"}`
          : JSON.stringify(data, null, 2),
      ready: true,
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

/** 推断展示标签 */
export function inferLabel(type: string): string {
  if (type === "recommendations") return "建议";
  if (type === "diagnosis") return "诊断";
  if (type === "analysis_summary") return "分析";
  if (type === "pending") return "分析中…";
  return "产物";
}

/** 推断 ArtifactPanel type */
export function inferArtifactType(_type: string): "markdown" | "code" {
  return "code";
}
