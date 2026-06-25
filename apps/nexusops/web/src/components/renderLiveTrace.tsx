import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace, CollapsibleToolTrace } from "@meso.ai/ui";
import { StepTrace } from "./StepTrace.js";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 设计：采用Claude Code的设计思路，采用@meso.ai/ui组件
 *  - Verbose OFF: 简洁模式 - 仅展示 WorkflowTimeline + StepTrace，工具细节按需展开
 *  - Verbose ON: 详细模式 - 展示 ProcessTrace + StepTrace + 完整工具链
 *
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线（skill.* 内部步骤）
 *  2. ProcessTrace —— phase / think / tool_call 统一执行区（ReAct 步骤）
 *  3. StepTrace —— nexusops特定的能力展示（推荐、证据等）
 *  4. CollapsibleToolTrace —— 完整工具调用链（仅在 verbose 或需要时展开）
 */
export interface RenderLiveTraceOptions {
  streaming: boolean;
  verbose?: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}

export function createRenderLiveTrace(opts: RenderLiveTraceOptions) {
  return (stream: StreamState) => <LiveTrace stream={stream} {...opts} />;
}

function LiveTrace({
  stream,
  streaming,
  verbose = false,
  onToolConfirm,
  onToolCancel,
}: {
  stream: StreamState;
  streaming: boolean;
  verbose?: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}) {
  const runs = stream.workflowRunOrder.map((id) => stream.workflowRuns[id]).filter(Boolean);
  const toolCallCount = stream.toolCallOrder.length;

  return (
    <div className="nexus-live-trace">
      {runs.length > 0 && <WorkflowTimeline runs={runs} />}

      {/* 根据 verbose 模式决定显示策略 */}
      {verbose ? (
        /* Verbose ON: 展示完整的 ProcessTrace + StepTrace + 可折叠工具细节 */
        <>
          <ProcessTrace
            stream={stream}
            streaming={streaming}
            turnStreaming={stream.status === "streaming"}
            onToolConfirm={onToolConfirm}
            onToolCancel={onToolCancel}
          />
          <StepTrace stream={stream} />

          {toolCallCount > 0 && (
            <details className="streaming-details">
              <summary className="streaming-summary">
                📋 完整工具链 ({toolCallCount} 步操作)
              </summary>
              <CollapsibleToolTrace stream={stream} />
            </details>
          )}
        </>
      ) : (
        /* Verbose OFF: 简洁模式 - 仅展示工具细节（可折叠） */
        <>
          <ProcessTrace
            stream={stream}
            streaming={streaming}
            turnStreaming={stream.status === "streaming"}
            onToolConfirm={onToolConfirm}
            onToolCancel={onToolCancel}
          />
          <StepTrace stream={stream} />

          {toolCallCount > 0 && (
            <details className="streaming-details">
              <summary className="streaming-summary">
                📋 执行细节 ({toolCallCount} 步)
              </summary>
              <CollapsibleToolTrace stream={stream} />
            </details>
          )}
        </>
      )}
    </div>
  );
}
