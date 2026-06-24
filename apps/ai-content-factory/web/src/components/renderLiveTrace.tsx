import type { StreamState, ToolCallState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace } from "@meso.ai/ui";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 改进：采用Claude Code的设计思路
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线
 *  2. ProcessTrace —— phase / think / tool_call（简化显示，隐藏元数据）
 *  3. 可折叠执行细节 —— 点击展开查看完整的工具调用链、参数、耗时
 *
 * 效果：主消息流保持简洁线性，详情按需展开
 */
export interface RenderLiveTraceOptions {
  streaming: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}

export function createRenderLiveTrace(opts: RenderLiveTraceOptions) {
  return (stream: StreamState) => <LiveTrace stream={stream} {...opts} />;
}

function LiveTrace({
  stream,
  streaming,
  onToolConfirm,
  onToolCancel,
}: {
  stream: StreamState;
  streaming: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}) {
  const runs = stream.workflowRunOrder.map((id) => stream.workflowRuns[id]).filter(Boolean);
  const toolCallCount = stream.toolCallOrder.length;

  return (
    <div className="podcast-live-trace">
      {runs.length > 0 && <WorkflowTimeline runs={runs} />}
      <ProcessTrace
        stream={stream}
        streaming={streaming}
        turnStreaming={stream.status === "streaming"}
        onToolConfirm={onToolConfirm}
        onToolCancel={onToolCancel}
      />

      {/* 可折叠的执行细节面板 */}
      {toolCallCount > 0 && (
        <details className="podcast-execution-details">
          <summary className="podcast-execution-summary">
            📋 执行细节 ({toolCallCount} 步操作)
          </summary>
          <StepTraceCollapsible stream={stream} />
        </details>
      )}
    </div>
  );
}

/**
 * 工具调用链的可折叠展示（复用StepTrace逻辑）
 */
function StepTraceCollapsible({ stream }: { stream: StreamState }) {
  const steps = stream.toolCallOrder
    .map((id) => stream.toolCalls[id])
    .filter((tc): tc is ToolCallState => Boolean(tc));

  if (steps.length === 0) return null;

  return (
    <div className="podcast-step-trace">
      {steps.map((tc, i) => (
        <StepItemDetail key={tc.call.id} index={i} tc={tc} />
      ))}
    </div>
  );
}

function StepItemDetail({ index, tc }: { index: number; tc: ToolCallState }) {
  const name = tc.call.name ?? "unknown";
  const status = !tc.result ? "running" : tc.result.error ? "error" : "done";

  return (
    <div className="podcast-step-item">
      <div className="podcast-step-header">
        <span className="podcast-step-num" data-status={status}>
          {status === "running" ? "…" : index + 1}
        </span>
        <code className="podcast-step-name">{name}</code>
        <span className="podcast-step-status">{status === "done" ? "✓" : status === "error" ? "✗" : "⟳"}</span>
      </div>

      {/* 参数显示 */}
      {tc.call.args && Object.keys(tc.call.args).length > 0 && (
        <div className="podcast-step-args">
          <div className="podcast-step-args-label">参数：</div>
          <code className="podcast-step-args-value">{summarizeArgs(tc.call.args)}</code>
        </div>
      )}

      {/* 结果/错误显示 */}
      {tc.result && (
        <div className={`podcast-step-result podcast-step-result-${status}`}>
          <div className="podcast-step-result-label">结果：</div>
          <div className="podcast-step-result-value">
            {status === "error" ? tc.result.error : truncate(tc.result.output, 200)}
          </div>
        </div>
      )}
    </div>
  );
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
