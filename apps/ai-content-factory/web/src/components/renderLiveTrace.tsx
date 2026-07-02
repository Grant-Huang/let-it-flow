import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline } from "@meso.ai/ui";
import { ExecutionDetails } from "./ExecutionDetails.js";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 风格规范见 docs/24-conversational-streaming-style.md。
 * 采用自写 ExecutionDetails（叙述文本 + 工具行交错），与 nexusops 视觉统一：
 *   - 工具行不装箱：mono 工具名 + chevron + 状态文本 + 证据徽章
 *   - 叙述文本 14px，简单 markdown（**bold** / - bullet）
 *   - 隐藏 meta 工具（nexus_finalize 等）
 *   - 工具参数/输出可折叠，代码块低对比
 *
 * verbose 开关仅控制是否显示 WorkflowTimeline（DAG 时间线）。
 * 工具细节的展开/折叠由 ExecutionDetails 内部 chevron 管理，无需外层 verbose。
 */
export interface RenderLiveTraceOptions {
  streaming: boolean;
  verbose?: boolean;
  /** 保留字段以兼容调用方；ExecutionDetails 不处理 tool_call 级确认（走 extension ConfirmGateCard）。 */
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}

export function createRenderLiveTrace(opts: RenderLiveTraceOptions) {
  return (stream: StreamState) => <LiveTrace stream={stream} {...opts} />;
}

function LiveTrace({
  stream,
  verbose = false,
}: {
  stream: StreamState;
  streaming: boolean;
  verbose?: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}) {
  const runs = stream.workflowRunOrder.map((id) => stream.workflowRuns[id]).filter(Boolean);

  return (
    <div className="aicf-live-trace">
      {/* verbose 模式才显示 DAG 时间线（podcast 多为线性 ReAct，默认折叠减少噪音） */}
      {verbose && runs.length > 0 && <WorkflowTimeline runs={runs} />}

      {/* 叙述文本 + 工具行交错（自写组件，与 nexusops 风格统一） */}
      <ExecutionDetails stream={stream} />
    </div>
  );
}
