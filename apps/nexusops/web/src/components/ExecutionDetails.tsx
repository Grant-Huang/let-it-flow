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

  for (const ev of stream.eventLog) {
    if (ev.type === "text") {
      pendingText += ((ev.data as { delta?: string }).delta ?? "");
    } else if (ev.type === "tool_call") {
      const tcId = (ev.data as { id?: string }).id ?? "";
      const tc = stream.toolCalls[tcId];
      const toolName = tc?.call.name ?? "";

      if (HIDDEN_TOOLS.has(toolName)) continue;

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
        const dynamicDesc = (tc.call.metadata?.custom as Record<string, unknown> | undefined)?.description;
        const description = typeof dynamicDesc === "string" ? dynamicDesc : getToolDescription(name);
        const status = !tc.result ? "running" : "done";
        const isExpanded = expandedTools.has(node.id);

        return (
          <div key={node.id} className="tool-item">
            {/* 主行：toggle + 工具名 + 状态 */}
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
              <span className="tool-toggle-icon">{isExpanded ? "▾" : "▸"}</span>
              <code className="tool-name">{name}</code>
              <span className={`tool-status-badge tool-status-${status}`}>
                {status === "done" ? "✓" : "⧗"}
              </span>
            </div>

            {/* 描述：小号灰色，缩进对齐 */}
            {description && (
              <div className="tool-desc-line">{description}</div>
            )}

            {/* 展开内容 */}
            {isExpanded && (
              <div className="tool-expanded">
                {tc.call.args && Object.keys(tc.call.args).length > 0 && (
                  <details className="tool-section" open={false}>
                    <summary className="tool-section-title">&gt; Input Parameters</summary>
                    <pre className="code-block">{JSON.stringify(tc.call.args, null, 2)}</pre>
                  </details>
                )}
                {tc.result?.output && (
                  <details className="tool-section" open={false}>
                    <summary className="tool-section-title">&gt; Output</summary>
                    <pre className="code-block">{tc.result.output.slice(0, 500)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* 结果摘要 + 证据徽章 */}
            <div className="tool-result-line">
              {tc.result?.output ? truncateResult(tc.result.output, 100) : "执行中…"}
              {evidence && (
                <span className="evidence-badge-container">
                  <EvidenceBadge data={evidence} />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 渲染简单 Markdown：**bold** → <strong>，保留换行 */
function renderSimpleMarkdown(text: string): React.ReactNode {
  return text.split("\n").map((line, i) => {
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
        {parts.length > 0 ? parts : " "}
        {"\n"}
      </span>
    );
  });
}

function getToolDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    "query_oee": "查询 OEE 实时数据",
    "analyze_oee": "分析 OEE 变化趋势",
    "oee_breakdown": "OEE 维度分解（可用率、性能、质量）",
    "oee.history": "查询 OEE 历史趋势",
    "oee.decompose": "OEE 损失分解分析",
    "oee.availability_loss": "可用率损失分析",
    "oee.performance_loss": "性能损失分析",
    "oee.quality_loss": "质量损失分析",
    "query_equipment": "查询设备状态和停机日志",
    "equipment.downtime": "分析设备停机原因",
    "equipment.mtbf": "计算设备平均故障间隔",
    "equipment_downtime": "分析设备停机原因",
    "maintenance_history": "查询设备维保历史",
    "quality_defect": "分析质量缺陷率",
    "quality_trend": "质量指标趋势分析",
    "defect_pareto": "缺陷帕累托分析",
    "process_parameters": "查询工艺参数",
    "process_variance": "工艺波动分析",
    "energy_consumption": "能耗数据查询",
    "energy_efficiency": "能效分析",
    "schedule_plan": "查询生产排程",
    "schedule_variance": "排程偏差分析",
    "material_usage": "物料用量查询",
    "material_cost": "物料成本分析",
    "extract_5why": "5Why 根因分析链",
    "build_fishbone": "鱼骨图分析",
    "run_fmea": "失效模式影响分析 (FMEA)",
    "cross_validate": "交叉验证分析结果",
    "query_db": "查询数据库信息",
    "query_data": "查询数据",
    "fetch_metrics": "获取业务指标",
    "format_data": "格式化输出数据",
    "summarize": "生成分析总结",
    "validate": "验证数据有效性",
    "generate_report": "生成分析报告",
    "core.deliver": "产物聚合，输出最终结果",
    "skill.search": "搜索相关数据",
    "skill.analyze": "数据分析",
    "skill.recommend": "生成改善建议",
    "skill.downtime": "停机根因分析",
  };

  if (descriptions[toolName]) return descriptions[toolName];
  for (const [key, desc] of Object.entries(descriptions)) {
    if (toolName.includes(key)) return desc;
  }
  if (toolName.startsWith("skill.")) return `执行技能：${toolName.slice(6)}`;
  if (toolName.startsWith("oee.")) return `OEE 分析：${toolName.slice(4)}`;
  if (toolName.startsWith("equipment.")) return `设备分析：${toolName.slice(10)}`;
  if (toolName.includes("query") || toolName.includes("get") || toolName.includes("fetch"))
    return `查询 ${toolName.split("_")[1] || "数据"}`;
  if (toolName.includes("analyze") || toolName.includes("check"))
    return `分析 ${toolName.split("_")[1] || "数据"}`;
  return `执行 ${toolName}`;
}

function truncateResult(result: string, maxLength: number): string {
  if (typeof result !== "string") return JSON.stringify(result).slice(0, maxLength);
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}
