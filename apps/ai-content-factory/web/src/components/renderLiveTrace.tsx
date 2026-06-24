import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace } from "@meso.ai/ui";
import { CollapsibleStepTrace } from "@let-it-flow/common-ui";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 改进：采用Claude Code的设计思路
 *  1. WorkflowTimeline —— DAG run + 节点状态时间线
 *  2. ProcessTrace —— phase / think / tool_call（简化显示，隐藏元数据）
 *  3. 可折叠执行细节 —— 点击展开查看完整的工具调用链、参数、耗时（平台级组件）
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

      {/* 可折叠的执行细节面板（平台级通用组件） */}
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
