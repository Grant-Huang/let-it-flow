import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace } from "@meso.ai/ui";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 组合两块（见 docs/14-podcast-generator-frontend.md §14.4.1）：
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线（fetch/search/rewrite/.../deliver）
 *  2. ProcessTrace —— phase / think / tool_call 统一执行区
 *
 * 两块都依赖 StreamState，且都会在无数据时自行渲染 null，因此可无条件挂载。
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
    </div>
  );
}
