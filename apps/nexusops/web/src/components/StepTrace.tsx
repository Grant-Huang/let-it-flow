import type { StreamState, ToolCallState } from "@meso.ai/types";
import { EvidenceBadge, parseEvidenceFromOutput } from "./EvidenceBadge.js";

/**
 * ReAct 步骤时间线（自写）。
 *
 * 把 StreamState.toolCalls 渲染成 Thought→Action→Observation 时间线：
 *  - 每个工具调用一个节点，显示工具名 + 参数摘要 + 状态
 *  - 工具结果若为 EvidenceEnvelope，显示时效/置信度/来源徽章
 *  - skill.* 工具展开其内部 workflow_node 步骤
 *
 * 与 ProcessTrace（meso 组件）互补：ProcessTrace 渲染 phase/think，
 * 本组件专注把 ReAct 的 Action/Observation 链可视化。
 */
export function StepTrace({ stream }: { stream: StreamState }) {
  const steps = stream.toolCallOrder
    .map((id) => stream.toolCalls[id])
    .filter((tc): tc is ToolCallState => Boolean(tc));

  if (steps.length === 0) return null;

  return (
    <div className="nexus-step-trace">
      <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
        ReAct 工具链（{steps.length} 次调用）
      </div>
      {steps.map((tc, i) => (
        <StepItem key={tc.call.id} index={i} tc={tc} />
      ))}
    </div>
  );
}

function StepItem({ index, tc }: { index: number; tc: ToolCallState }) {
  const name = tc.call.name ?? "unknown";
  const isSkill = name.startsWith("skill.");
  const isAdvise = name === "nexus_advise";
  const evidence = tc.result ? parseEvidenceFromOutput(tc.result.output) : null;
  const status = !tc.result ? "running" : "done";

  return (
    <div className="nexus-step-item">
      <div className="nexus-step-num" style={status === "running" ? runningStyle : undefined}>
        {status === "running" ? "…" : index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <code style={{ fontSize: 12, fontWeight: 600, color: toolColor(name) }}>{name}</code>
          {isSkill && <Tag color="var(--color-accent)">skill</Tag>}
          {isAdvise && <Tag color="#8b5cf6">advise</Tag>}
          {tc.call.risk && tc.call.risk !== "safe" && (
            <Tag color="var(--color-warning)">{tc.call.risk}</Tag>
          )}
          {status === "running" && (
            <span style={{ fontSize: 11, color: "var(--color-info)" }}>执行中…</span>
          )}
        </div>
        {/* 参数摘要 */}
        {tc.call.args && Object.keys(tc.call.args).length > 0 && (
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
            {summarizeArgs(tc.call.args)}
          </div>
        )}
        {/* 证据徽章（EvidenceEnvelope） */}
        {evidence && (
          <div style={{ marginTop: 4 }}>
            <EvidenceBadge data={evidence} />
          </div>
        )}
      </div>
    </div>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{ fontSize: 10, padding: "0 4px", borderRadius: 3, background: `${color}22`, color, fontWeight: 600 }}>
      {children}
    </span>
  );
}

function toolColor(name: string): string {
  if (name.startsWith("oee.")) return "var(--color-success)";
  if (name.startsWith("equipment.")) return "var(--color-warning)";
  if (name.startsWith("quality.")) return "var(--color-error)";
  if (name.startsWith("process.")) return "var(--color-info)";
  if (name.startsWith("energy.")) return "#8b5cf6";
  if (name.startsWith("schedule.") || name.startsWith("material.")) return "#3b82f6";
  if (name.startsWith("core.")) return "var(--color-text-secondary)";
  return "var(--color-accent)";
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 4);
  return entries
    .map(([k, v]) => {
      const vs = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${truncate(vs, 30)}`;
    })
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const runningStyle: React.CSSProperties = {
  background: "var(--color-info)",
  animation: "pulse 1.2s infinite",
};
