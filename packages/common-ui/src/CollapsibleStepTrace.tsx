import type { StreamState, ToolCallState } from "@meso.ai/types";

/**
 * CollapsibleStepTrace
 *
 * 可折叠的工具调用链展示组件。
 *
 * 设计原则（参考Claude Code）：
 *  - 主流简洁：隐藏工具参数、耗时等元数据
 *  - 按需详情：点击展开按钮查看完整执行链
 *  - 优先级清晰：工具状态（✓/✗/⟳）始终可见
 *
 * 用法：
 * ```tsx
 * <details className="streaming-details">
 *   <summary className="streaming-summary">📋 执行细节 (5 步)</summary>
 *   <CollapsibleStepTrace stream={state} />
 * </details>
 * ```
 */
export function CollapsibleStepTrace({ stream }: { stream: StreamState }) {
  const steps = stream.toolCallOrder
    .map((id) => stream.toolCalls[id])
    .filter((tc): tc is ToolCallState => Boolean(tc));

  if (steps.length === 0) return null;

  return (
    <div className="streaming-step-trace">
      {steps.map((tc, i) => (
        <StepItem key={tc.call.id} index={i} tc={tc} />
      ))}
    </div>
  );
}

function StepItem({ index, tc }: { index: number; tc: ToolCallState }) {
  const name = tc.call.name ?? "unknown";
  const status = !tc.result ? "running" : tc.result.error ? "error" : "done";

  return (
    <div className="streaming-step-item" data-status={status}>
      <div className="streaming-step-header">
        <span className="streaming-step-num">{status === "running" ? "…" : index + 1}</span>
        <code className="streaming-step-name">{name}</code>
        <span className="streaming-step-status">{getStatusIcon(status)}</span>
      </div>

      {/* 参数显示 */}
      {tc.call.args && Object.keys(tc.call.args).length > 0 && (
        <div className="streaming-step-args">
          <span className="streaming-step-args-label">参数：</span>
          <code className="streaming-step-args-value">{summarizeArgs(tc.call.args)}</code>
        </div>
      )}

      {/* 结果/错误显示 */}
      {tc.result && (
        <div className="streaming-step-result">
          <span className="streaming-step-result-label">结果：</span>
          <div className="streaming-step-result-value">
            {status === "error" ? tc.result.error : truncate(tc.result.output, 200)}
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusIcon(status: "done" | "error" | "running"): string {
  switch (status) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "running":
      return "⟳";
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 3);
  return entries
    .map(([k, v]) => {
      const vs = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${truncate(vs, 40)}`;
    })
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
