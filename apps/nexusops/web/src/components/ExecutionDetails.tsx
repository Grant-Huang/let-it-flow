import type { StreamState, ToolCallState } from "@meso.ai/types";
import { useState } from "react";
import { EvidenceBadge, type EvidenceBadgeData, parseEvidenceFromOutput } from "./EvidenceBadge.js";

/**
 * 执行细节（可折叠）。
 *
 * 展示所有工具调用的详细信息（工具名、参数、输出）。
 * 平铺列表，无分组标题。默认折叠，用户可按需展开查看技术细节。
 */

interface ToolItem {
  id: string;
  name: string;
  description?: string;
  args?: Record<string, unknown>;
  result?: string;
  evidence?: EvidenceBadgeData | null;
  status: "running" | "done" | "error";
}

export function ExecutionDetails({ stream }: { stream: StreamState }) {
  const toolCalls = stream.toolCallOrder
    .map((id) => stream.toolCalls[id])
    .filter((tc): tc is ToolCallState => Boolean(tc));

  if (toolCalls.length === 0) return null;

  const toolItems: ToolItem[] = toolCalls.map((tc) => {
    const name = tc.call.name ?? "unknown";
    const evidence = tc.result ? parseEvidenceFromOutput(tc.result.output) : null;
    const dynamicDesc = (tc.call.metadata?.custom as Record<string, unknown> | undefined)?.description;

    return {
      id: tc.call.id,
      name,
      description: typeof dynamicDesc === "string" ? dynamicDesc : undefined,
      args: tc.call.args,
      result: tc.result?.output,
      evidence,
      status: !tc.result ? "running" : "done",
    };
  });

  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleToolExpansion = (toolId: string) => {
    const newSet = new Set(expandedTools);
    if (newSet.has(toolId)) {
      newSet.delete(toolId);
    } else {
      newSet.add(toolId);
    }
    setExpandedTools(newSet);
  };

  return (
    <div className="execution-details">
      {toolItems.map((tool) => (
        <div key={tool.id} className="tool-item">
          <div className="tool-description">
            - {tool.description || getToolDescription(tool.name)}
          </div>
          <div className="tool-details">
            <div
              className="tool-name-expandable"
              onClick={() => toggleToolExpansion(tool.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleToolExpansion(tool.id);
                }
              }}
            >
              <span className="toggle-icon">
                {expandedTools.has(tool.id) ? "▾" : "▸"}
              </span>
              <code className="tool-name">{tool.name}</code>
              <span className="status-badge">
                {tool.status === "done" ? "✓" : tool.status === "running" ? "⧗" : "✗"}
              </span>
            </div>

            {expandedTools.has(tool.id) && (
              <div className="tool-content">
                {/* Input Parameters */}
                {tool.args && Object.keys(tool.args).length > 0 && (
                  <details className="tool-section" open={false}>
                    <summary className="tool-section-title">
                      &gt; Input Parameters
                    </summary>
                    <div className="tool-section-content">
                      <pre className="code-block">
                        {JSON.stringify(tool.args, null, 2)}
                      </pre>
                    </div>
                  </details>
                )}

                {/* Output */}
                {tool.result && (
                  <details className="tool-section" open={false}>
                    <summary className="tool-section-title">
                      &gt; Output
                    </summary>
                    <div className="tool-section-content">
                      <pre className="code-block">
                        {typeof tool.result === "string"
                          ? tool.result.slice(0, 500)
                          : JSON.stringify(tool.result, null, 2).slice(0, 500)}
                      </pre>
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Result */}
            <div className="tool-result">
              → {tool.result ? truncateResult(tool.result, 100) : "执行中…"}
              {tool.evidence && (
                <div className="evidence-badge-container">
                  <EvidenceBadge data={tool.evidence} />
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function getToolDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    // OEE 相关
    "query_oee": "查询 OEE 实时数据",
    "analyze_oee": "分析 OEE 变化趋势",
    "oee_breakdown": "OEE 维度分解（可用率、性能、质量）",

    // 设备相关
    "query_equipment": "查询设备状态和停机日志",
    "equipment_downtime": "分析设备停机原因",
    "maintenance_history": "查询设备维保历史",

    // 质量相关
    "quality_defect": "分析质量缺陷率",
    "quality_trend": "质量指标趋势分析",
    "defect_pareto": "缺陷帕累托分析",

    // 工艺相关
    "process_parameters": "查询工艺参数",
    "process_variance": "工艺波动分析",

    // 能源相关
    "energy_consumption": "能耗数据查询",
    "energy_efficiency": "能效分析",

    // 排程相关
    "schedule_plan": "查询生产排程",
    "schedule_variance": "排程偏差分析",

    // 物料相关
    "material_usage": "物料用量查询",
    "material_cost": "物料成本分析",

    // 根因分析工具
    "extract_5why": "5Why 根因分析链",
    "build_fishbone": "鱼骨图分析",
    "run_fmea": "失效模式影响分析 (FMEA)",
    "cross_validate": "交叉验证分析结果",

    // 通用数据工具
    "query_db": "查询数据库信息",
    "query_data": "查询数据",
    "fetch_metrics": "获取业务指标",
    "format_data": "格式化输出数据",
    "summarize": "生成分析总结",
    "validate": "验证数据有效性",
    "generate_report": "生成分析报告",

    // 核心工具
    "core.deliver": "产物聚合，输出最终结果",

    // Skill 工具
    "skill.search": "搜索相关数据",
    "skill.analyze": "数据分析",
    "skill.recommend": "生成改善建议",
    "skill.downtime": "停机根因分析",
  };

  if (descriptions[toolName]) {
    return descriptions[toolName];
  }

  for (const [key, desc] of Object.entries(descriptions)) {
    if (toolName.includes(key)) {
      return desc;
    }
  }

  if (toolName.startsWith("skill.")) {
    return `执行技能：${toolName.slice(6)}`;
  }
  if (toolName.includes("query") || toolName.includes("get") || toolName.includes("fetch")) {
    return `查询 ${toolName.split("_")[1] || "数据"}`;
  }
  if (toolName.includes("analyze") || toolName.includes("check")) {
    return `分析 ${toolName.split("_")[1] || "数据"}`;
  }

  return `执行 ${toolName}`;
}

function truncateResult(result: string, maxLength: number): string {
  if (typeof result !== "string") {
    return JSON.stringify(result).slice(0, maxLength);
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}
