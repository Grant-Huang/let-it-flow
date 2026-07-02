import type { StreamState, ToolCallState } from "@meso.ai/types";
import { useState } from "react";
import { EvidenceBadge, type EvidenceBadgeData, parseEvidenceFromOutput } from "./EvidenceBadge.js";

/**
 * 执行详情组件：把「助手叙述文本」与「工具调用行」按 eventLog 顺序交错排列。
 *
 * 风格规范见 docs/24-conversational-streaming-style.md §3.2 / §3.3。
 * 从 apps/nexusops/web/src/components/ExecutionDetails.tsx 移植，适配 podcast 工具。
 */

/** 内部 meta 工具：不在 ExecutionDetails 中显示，有独立渲染路径（产物面板/收尾）。 */
const HIDDEN_TOOLS = new Set([
  "nexus_finalize",
  "nexus_advise",
  "nexus.finalize",
  "nexus.advise",
]);

type RenderNode =
  | { kind: "text"; content: string }
  | { kind: "tool"; id: string };

/** 按 eventLog 顺序把叙述文本和工具调用交错排列（隐藏 meta 工具）。 */
function buildRenderNodes(stream: StreamState): RenderNode[] {
  const nodes: RenderNode[] = [];
  let pendingText = "";
  const seenToolIds = new Set<string>();

  for (const ev of stream.eventLog) {
    if (ev.type === "text") {
      pendingText += (ev.data as { delta?: string }).delta ?? "";
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
        const dynamicDesc = (tc.call.metadata?.custom as Record<string, unknown> | undefined)?.description;
        const description = typeof dynamicDesc === "string" ? dynamicDesc : getToolDescription(name);

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

            {/* 描述行：· description */}
            {description && (
              <div className="tool-desc-line">
                <span className="tool-desc-mark">·</span>
                {" "}{description}
              </div>
            )}

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

/** 渲染简单 Markdown：**bold** → <strong>，- item → · bullet，保留换行 */
function renderSimpleMarkdown(text: string): React.ReactNode {
  const cleaned = text.replace(/\p{Emoji_Presentation}/gu, "").replace(/  +/g, " ");
  return cleaned.split("\n").map((line, i) => {
    // 检测 bullet 行（"- " 前缀，可有缩进）
    const bulletMatch = line.match(/^(\s*)- (.*)/);
    if (bulletMatch) {
      const [, indent, content] = bulletMatch;
      return (
        <span key={i} className="narrative-bullet">
          {indent}
          <span className="narrative-bullet-mark">·</span>
          {" "}
          {renderInlineMarkdown(content)}
          {"\n"}
        </span>
      );
    }

    return (
      <span key={i}>
        {renderInlineMarkdown(line) || " "}
        {"\n"}
      </span>
    );
  });
}

/** 处理行内 Markdown（**bold**） */
function renderInlineMarkdown(line: string): React.ReactNode {
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
  return parts.length > 0 ? parts : null;
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

/**
 * 工具描述映射（podcast 链路）。无匹配时返回空字符串（不显示描述行）。
 *
 * 覆盖 ai-content-factory 的 core.* / skill.* / nexus_finalize 工具。
 */
function getToolDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    "core.web_search": "搜索内容",
    "core.web_fetch": "抓取网页正文",
    "core.knowledge_base": "查询本地知识库",
    "core.llm_node": "LLM 生成节点",
    "core.deliver": "汇总输出最终结果",
    "skill.thread_focuser": "聚焦单一主线索",
    "skill.write_podcast_script": "撰写口播稿",
    "skill.write_wechat_article": "撰写公众号长文",
    "skill.publish_wechat_draft": "推送到微信草稿箱",
    "nexus_finalize": "流程收尾",
  };

  if (descriptions[toolName]) return descriptions[toolName];
  for (const [key, desc] of Object.entries(descriptions)) {
    if (toolName.includes(key)) return desc;
  }
  if (toolName.startsWith("skill.")) return `执行 ${toolName.slice(6)} 流程`;
  if (toolName.startsWith("core.")) return `调用 ${toolName.slice(5)}`;
  return "";
}
