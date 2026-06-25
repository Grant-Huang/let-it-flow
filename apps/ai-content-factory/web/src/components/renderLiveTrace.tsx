import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace, CollapsibleToolTrace } from "@meso.ai/ui";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 设计：采用Claude Code的设计思路
 *  - Verbose OFF: 简洁模式 - 仅展示 WorkflowTimeline，工具细节按需展开
 *  - Verbose ON: 详细模式 - 展示 ProcessTrace + 工具调用完整链
 *
 * 组件来源：完全使用 @meso.ai/ui 的流式 UI 套件
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线
 *  2. ProcessTrace —— phase / think / tool_call 执行过程
 *  3. CollapsibleToolTrace —— 可折叠的工具调用详情（仅在 verbose 或需要时展开）
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
    <div className="podcast-live-trace">
      {runs.length > 0 && <WorkflowTimeline runs={runs} />}

      {/* 根据 verbose 模式决定显示策略 */}
      {verbose ? (
        /* Verbose ON: 展示完整的 ProcessTrace + 可折叠工具细节 */
        <>
          <ProcessTrace
            stream={stream}
            streaming={streaming}
            turnStreaming={stream.status === "streaming"}
            onToolConfirm={onToolConfirm}
            onToolCancel={onToolCancel}
          />

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
