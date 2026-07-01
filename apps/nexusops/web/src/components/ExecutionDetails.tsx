import type { StreamState, ToolCallState } from "@meso.ai/types";
import { useState } from "react";
import { EvidenceBadge, type EvidenceBadgeData, parseEvidenceFromOutput } from "./EvidenceBadge.js";

/**
 * 执行细节（可折叠）。
 *
 * 展示所有工具调用的详细信息（工具名、参数、输出）。
 * 默认折叠，用户可按需展开查看技术细节。
 *
 * 结构：
 *  ▶ 工作流名 (N/M 工具)
 *    - 工具说明
 *      > 工具名（可折叠）
 *        > Input Parameters（可折叠）
 *        > Output（可折叠）
 *      → 结果（展开状态）
 */

interface ToolItem {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  evidence?: EvidenceBadgeData | null;
  status: "running" | "done" | "error";
}

interface WorkflowGroup {
  name: string;
  tools: ToolItem[];
}

export function ExecutionDetails({ stream }: { stream: StreamState }) {
  const toolCalls = stream.toolCallOrder
    .map((id) => stream.toolCalls[id])
    .filter((tc): tc is ToolCallState => Boolean(tc));

  if (toolCalls.length === 0) return null;

  // 将工具调用分组为工作流（基于工作流节点或简单的顺序分组）
  const workflows = groupToolsByWorkflow(toolCalls);

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
      {workflows.map((workflow, wfIndex) => (
        <div key={wfIndex} className="workflow-group">
          <div className="workflow-header">
            ▶ {workflow.name} ({workflow.tools.length} 工具)
          </div>
          {workflow.tools.map((tool) => (
            <div key={tool.id} className="tool-item">
              <div className="tool-description">
                - {getToolDescription(tool.name)}
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
      ))}
    </div>
  );
}

function groupToolsByWorkflow(toolCalls: ToolCallState[]): WorkflowGroup[] {
  // 简单的分组策略：按tool name的前缀（domain）分组
  const groups: Map<string, ToolItem[]> = new Map();

  toolCalls.forEach((tc) => {
    const name = tc.call.name ?? "unknown";
    const domain = name.split(".")[0] || "default";
    const evidence = tc.result ? parseEvidenceFromOutput(tc.result.output) : null;

    const toolItem: ToolItem = {
      id: tc.call.id,
      name: name,
      args: tc.call.args,
      result: tc.result?.output,
      evidence: evidence,
      status: !tc.result ? "running" : "done",
    };

    if (!groups.has(domain)) {
      groups.set(domain, []);
    }
    groups.get(domain)!.push(toolItem);
  });

  // 转换为工作流组
  const workflows: WorkflowGroup[] = Array.from(groups.entries()).map(
    ([domain, tools]) => ({
      name: `${domain} workflow`,
      tools,
    })
  );

  return workflows;
}

function getToolDescription(toolName: string): string {
  // 返回工具的人类可读的描述
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

    // Skill 工具
    "skill.search": "搜索相关数据",
    "skill.analyze": "数据分析",
    "skill.recommend": "生成改善建议",
    "skill.downtime": "停机根因分析",
  };

  // 精确匹配
  if (descriptions[toolName]) {
    return descriptions[toolName];
  }

  // 模糊匹配（按关键词）
  for (const [key, desc] of Object.entries(descriptions)) {
    if (toolName.includes(key)) {
      return desc;
    }
  }

  // 默认描述：根据工具名推断
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
