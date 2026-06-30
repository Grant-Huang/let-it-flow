import type { StreamState } from "@meso.ai/types";
import { ProcessTrace } from "@meso.ai/ui";
import { useState } from "react";
import { ExecutionDetails } from "./ExecutionDetails.js";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 新设计：单一主对话流 + 可折叠执行细节
 *
 * 2层结构：
 *  1. ProcessTrace —— 主对话流（意图、编排、工作流+工具说明、结果、总结、输出物）
 *  2. ExecutionDetails —— 执行细节（工作流、工具、参数、输出）（默认折叠）
 *
 * 用户可点击"执行细节"展开技术细节，不破坏主线叙述的清晰性。
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
  const toolCallCount = stream.toolCallOrder.length;

  // 可折叠状态：执行细节默认折叠
  const [expandedDetails, setExpandedDetails] = useState(false);

  const toggleDetails = () => {
    setExpandedDetails(!expandedDetails);
  };

  return (
    <div className="nexus-live-trace">
      {/* 第1层：主对话流（ProcessTrace） */}
      <section className="live-trace-section">
        <div className="live-trace-content">
          <ProcessTrace
            stream={stream}
            streaming={streaming}
            turnStreaming={stream.status === "streaming"}
            onToolConfirm={onToolConfirm}
            onToolCancel={onToolCancel}
          />
        </div>
      </section>

      {/* 第2层：执行细节（可折叠） */}
      {toolCallCount > 0 && (
        <section className="live-trace-section">
          <h3
            className="live-trace-toggle"
            onClick={toggleDetails}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleDetails();
              }
            }}
          >
            <span className="toggle-icon">{expandedDetails ? '▾' : '▸'}</span>
            执行细节 ({toolCallCount} 步操作)
          </h3>
          {expandedDetails && (
            <div className="live-trace-content">
              <ExecutionDetails stream={stream} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
