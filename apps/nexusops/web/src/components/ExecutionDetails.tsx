import type { StreamState, ToolCallState } from "@meso.ai/types";
import { useState } from "react";
import { EvidenceBadge, type EvidenceBadgeData, parseEvidenceFromOutput } from "./EvidenceBadge.js";

/** 内部 meta 工具：不在 ExecutionDetails 中显示，有独立渲染路径 */
const HIDDEN_TOOLS = new Set(["nexus_finalize", "nexus_advise", "nexus.finalize", "nexus.advise"]);

type RenderNode =
  | { kind: "text"; content: string }
  | { kind: "tool"; id: string };

/** 按 eventLog 顺序把叙述文本和工具调用交错排列（隐藏 meta 工具） */
function buildRenderNodes(stream: StreamState): RenderNode[] {
  const nodes: RenderNode[] = [];
  let pendingText = "";
  const seenToolIds = new Set<string>();

  for (const ev of stream.eventLog) {
    if (ev.type === "text") {
      pendingText += ((ev.data as { delta?: string }).delta ?? "");
    } else if (ev.type === "tool_call") {
      const tcId = (ev.data as { id?: string }).id ?? "";
      const tc = stream.toolCalls[tcId];
      const toolName = tc?.call.name ?? "";

      if (HIDDEN_TOOLS.has(toolName)) continue;
      if (seenToolIds.has(tcId)) continue;
      seenToolIds.add(tcId);

      if (pendingText.trim()) {
        nodes.push({ kind: "text", content: pendingText });
        pendingText = "";
      } else {
        pendingText = "";
      }
      if (tcId && tc) {
        nodes.push({ kind: "tool", id: tcId });
      }
    }
  }
  if (pendingText.trim()) {
    nodes.push({ kind: "text", content: pendingText });
  }

  return nodes;
}

export function ExecutionDetails({ stream }: { stream: StreamState }) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleToolExpansion = (toolId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  const nodes = buildRenderNodes(stream);
  if (nodes.length === 0) return null;

  return (
    <div className="execution-details">
      {nodes.map((node, i) => {
        if (node.kind === "text") {
          return (
            <div key={`text-${i}`} className="narrative-text">
              {renderSimpleMarkdown(node.content)}
            </div>
          );
        }

        const tc = stream.toolCalls[node.id] as ToolCallState | undefined;
        if (!tc) return null;

        const name = tc.call.name ?? "unknown";
        const evidence = tc.result ? parseEvidenceFromOutput(tc.result.output) : null;
        const isExpanded = expandedTools.has(node.id);
        const hasError = tc.result?.error;

        const statusText = !tc.result
          ? "执行中…"
          : hasError
          ? "调用失败"
          : `返回 ${tc.result.output.length} 字`;

        return (
          <div key={node.id} className="tool-item">
            {/* 主行：工具名 + chevron（紧贴）| 右侧：状态 + 证据徽章 */}
            <div
              className="tool-name-row"
              onClick={() => toggleToolExpansion(node.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleToolExpansion(node.id);
                }
              }}
            >
              <div className="tool-name-left">
                <code className="tool-name">{name}</code>
                <span className={`tool-chevron${isExpanded ? " expanded" : ""}`}>›</span>
              </div>
              <div className="tool-name-right">
                <span className="tool-status-text">{statusText}</span>
                {evidence && <EvidenceBadge data={evidence} />}
              </div>
            </div>

            {/* 展开内容：普通标签 + code block，无 <details> 容器 */}
            {isExpanded && (
              <div className="tool-expanded">
                {tc.call.args && Object.keys(tc.call.args).length > 0 && (
                  <>
                    <div className="tool-section-label">&gt; Input Parameters</div>
                    <pre className="code-block">{JSON.stringify(tc.call.args, null, 2)}</pre>
                  </>
                )}
                {tc.result?.output && (
                  <>
                    <div className="tool-section-label">&gt; Output</div>
                    <pre className="code-block">{formatOutput(tc.result.output)}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 渲染简单 Markdown：**bold** → <strong>，保留换行 */
function renderSimpleMarkdown(text: string): React.ReactNode {
  const cleaned = text.replace(/\p{Emoji_Presentation}/gu, "").replace(/  +/g, " ");
  return cleaned.split("\n").map((line, i) => {
    const parts: React.ReactNode[] = [];
    let last = 0;
    const re = /\*\*(.+?)\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      parts.push(<strong key={m.index}>{m[1]}</strong>);
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return (
      <span key={i}>
        {parts.length > 0 ? parts : " "}
        {"\n"}
      </span>
    );
  });
}

/** 尝试将 JSON 字符串格式化为多行缩进；失败则截断返回原文 */
function formatOutput(output: string): string {
  const s = (output ?? "").trim();
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s.slice(0, 1000);
  }
}

function truncateResult(result: string, maxLength: number): string {
  if (typeof result !== "string") return JSON.stringify(result).slice(0, maxLength);
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}
