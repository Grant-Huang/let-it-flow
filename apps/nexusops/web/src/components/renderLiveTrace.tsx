import type { StreamState } from "@meso.ai/types";
import { WorkflowTimeline, ProcessTrace, CollapsibleToolTrace } from "@meso.ai/ui";
import { StepTrace } from "./StepTrace.js";
import { useState } from "react";

/**
 * 实时执行轨迹渲染（传给 MessageList.renderLiveTrace）。
 *
 * 设计：采用Claude Code的设计思路，采用@meso.ai/ui组件
 *
 * 3层结构（平铺+可折叠）：
 *  1. Phase —— 流水线阶段（始终显示）
 *  2. WorkflowTimeline —— DAG 节点时间线（默认展开）
 *  3. ProcessTrace —— ReAct 推理步骤（默认展开）
 *  4. StepTrace / CollapsibleToolTrace —— 工具执行细节（默认折叠，高级信息）
 *
 * 用户可手动切换展开/收起，降低初始认知负荷。
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

  // 可折叠状态：null=跟随系统默认，true/false=用户主动操作
  const [expandedSections, setExpandedSections] = useState({
    workflow: true,    // WorkflowTimeline 默认展开
    process: true,     // ProcessTrace 默认展开
    steps: false,      // StepTrace + ToolTrace 默认折叠（高级信息）
  });

  const toggle = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="nexus-live-trace">
      {/* 第1层：工作流时间线（DAG节点并行） */}
      {runs.length > 0 && (
        <section className="live-trace-section">
          <h3
            className="live-trace-toggle"
            onClick={() => toggle('workflow')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle('workflow');
              }
            }}
          >
            <span className="toggle-icon">{expandedSections.workflow ? '▾' : '▸'}</span>
            工作流执行
          </h3>
          {expandedSections.workflow && (
            <div className="live-trace-content">
              <WorkflowTimeline runs={runs} />
            </div>
          )}
        </section>
      )}

      {/* 第2层：推理过程（ReAct步骤并行） */}
      <section className="live-trace-section">
        <h3
          className="live-trace-toggle"
          onClick={() => toggle('process')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle('process');
            }
          }}
        >
          <span className="toggle-icon">{expandedSections.process ? '▾' : '▸'}</span>
          推理过程
        </h3>
        {expandedSections.process && (
          <div className="live-trace-content">
            <ProcessTrace
              stream={stream}
              streaming={streaming}
              turnStreaming={stream.status === "streaming"}
              onToolConfirm={onToolConfirm}
              onToolCancel={onToolCancel}
            />
          </div>
        )}
      </section>

      {/* 第3层：执行细节（工具链，默认折叠） */}
      <section className="live-trace-section">
        <h3
          className="live-trace-toggle"
          onClick={() => toggle('steps')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle('steps');
            }
          }}
        >
          <span className="toggle-icon">{expandedSections.steps ? '▾' : '▸'}</span>
          执行细节
          {toolCallCount > 0 && <span className="step-count"> ({toolCallCount} 步)</span>}
        </h3>
        {expandedSections.steps && (
          <div className="live-trace-content">
            <StepTrace stream={stream} />
            {toolCallCount > 0 && (
              <details className="streaming-details">
                <summary className="streaming-summary">
                  📋 工具调用链
                </summary>
                <CollapsibleToolTrace stream={stream} />
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
