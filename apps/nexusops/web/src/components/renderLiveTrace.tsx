import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace } from "@meso.ai/ui";
import { CollapsibleStepTrace } from "@let-it-flow/common-ui";
import { StepTrace } from "./StepTrace.js";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 改进：采用Claude Code的设计思路，采用平台级通用组件
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线（skill.* 内部步骤）
 *  2. ProcessTrace —— phase / think / tool_call 统一执行区（ReAct 步骤）
 *  3. StepTrace —— nexusops特定的能力展示（推荐、证据等）
 *  4. 可折叠执行细节 —— 点击展开查看完整的工具调用链（使用平台级组件）
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

      {/* 可折叠的完整执行细节（平台级通用组件） */}
      {toolCallCount > 0 && (
        <details className="streaming-details">
          <summary className="streaming-summary">
            📋 执行细节 ({toolCallCount} 步操作)
          </summary>
          <CollapsibleStepTrace stream={stream} />
        </details>
      )}
    </div>
  );
}
