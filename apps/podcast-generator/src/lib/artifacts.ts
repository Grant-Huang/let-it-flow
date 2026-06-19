import type { StreamState, ToolCallState } from "@meso.ai/types";

/**
 * 从 StreamState 提取 podcast 产物（见 docs/14-podcast-generator-frontend.md §14.3.3）。
 *
 * 当前后端 deliver 工具产出的是 tool_result（JSON 字符串 {type, title?, content}），
 * 而非协议层 artifact 事件。本模块从 toolCalls 中识别 core.deliver 调用并解析产物。
 * 后端改发 artifact 事件后，可无缝切换到 streamState.artifacts。
 */
export interface PodcastArtifact {
  id: string;
  type: string; // "podcast_script" / "podcast_video" / "text" ...
  title?: string;
  content: string;
  ready: boolean;
}

/**
 * 从流状态提取 deliver 产物。
 * 优先级：先看 streamState.artifacts（协议层，未来）；回退到 core.deliver tool_result。
 */
export function extractArtifacts(stream: StreamState): PodcastArtifact[] {
  // 未来：协议层 artifact 事件
  if (stream.artifactOrder.length > 0) {
    return stream.artifactOrder.map((id) => {
      const art = stream.artifacts[id];
      return {
        id,
        type: inferTypeFromLang(art.lang),
        content: art.content,
        ready: art.done,
      };
    });
  }

  // MVP：从 core.deliver tool_result 解析
  const out: PodcastArtifact[] = [];
  for (const id of stream.toolCallOrder) {
    const tc = stream.toolCalls[id];
    if (!tc) continue;
    if (tc.call.name !== "core.deliver") continue;
    const parsed = parseDeliverOutput(tc);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseDeliverOutput(tc: ToolCallState): PodcastArtifact | null {
  if (!tc.result) {
    // tool_result 尚未到达，产出占位
    return {
      id: tc.call.id,
      type: "pending",
      content: "",
      ready: false,
    };
  }
  try {
    const obj = JSON.parse(tc.result.output) as { type?: string; title?: string; content?: string };
    return {
      id: tc.call.id,
      type: obj.type ?? "text",
      title: obj.title,
      content: obj.content ?? "",
      ready: true,
    };
  } catch {
    return {
      id: tc.call.id,
      type: "text",
      content: tc.result.output,
      ready: true,
    };
  }
}

/** 根据 lang 推断产物类型标签 */
function inferTypeFromLang(lang: string): string {
  if (lang === "md" || lang === "markdown") return "podcast_script";
  if (lang === "mp4" || lang === "video") return "podcast_video";
  return lang;
}

/** 推断展示标签 */
export function inferLabel(type: string): string {
  if (type === "podcast_script") return "文稿";
  if (type === "podcast_video") return "视频";
  if (type === "pending") return "生成中…";
  return "产物";
}

/** 推断 ArtifactPanel type */
export function inferArtifactType(type: string): "markdown" | "code" {
  if (type === "podcast_script") return "markdown";
  return "code";
}
