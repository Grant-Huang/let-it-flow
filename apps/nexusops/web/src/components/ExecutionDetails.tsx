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
  // 返回工具的人类可读的描述（可以从tool registry扩展）
  const descriptions: Record<string, string> = {
    "query_db": "查询数据库信息",
    "format_data": "格式化输出数据",
    "validate": "验证数据有效性",
    // 可以继续添加更多描述
  };

  // 查找匹配的描述
  for (const [key, desc] of Object.entries(descriptions)) {
    if (toolName.includes(key)) {
      return desc;
    }
  }

  // 默认描述：使用工具名
  return `执行 ${toolName}`;
}

function truncateResult(result: string, maxLength: number): string {
  if (typeof result !== "string") {
    return JSON.stringify(result).slice(0, maxLength);
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}
