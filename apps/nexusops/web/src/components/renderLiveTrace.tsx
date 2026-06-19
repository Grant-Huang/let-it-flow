import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace } from "@meso.ai/ui";
import { StepTrace } from "./StepTrace.js";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 组合三块：
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线（skill.* 内部步骤）
 *  2. ProcessTrace —— phase / think / tool_call 统一执行区（ReAct 步骤）
 *  3. StepTrace —— 自写 ReAct 步骤时间线（Thought→Action→Observation）
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
    <div className="nexus-live-trace">
      {runs.length > 0 && <WorkflowTimeline runs={runs} />}
      <ProcessTrace
        stream={stream}
        streaming={streaming}
        turnStreaming={stream.status === "streaming"}
        onToolConfirm={onToolConfirm}
        onToolCancel={onToolCancel}
      />
      <StepTrace stream={stream} />
    </div>
  );
}
