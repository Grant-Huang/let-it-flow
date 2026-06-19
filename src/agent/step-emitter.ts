/**
 * 步骤发射器（E + O 层）。
 *
 * 把 AI SDK v6 的 OnStepFinishEvent（每步完成时的快照）转成：
 *   1. SSE 事件（phase running/done），供前端实时渲染 ReAct 步骤
 *   2. StepTrace 记录，累积成完整轨迹（O 层核心产物）
 *
 * OnStepFinishEvent 的 TOOLS 泛型与本模块无关，入参用 any 规避泛型穿透。
 * toolCalls/toolResults 在 step 完成时已全部就绪，故在此一次性转 trace。
 */
import { phasePayload } from "../core/stream-events.js";
import type { StepTrace, EmitFn } from "./types.js";
import { keyToToolName } from "./tool-adapter.js";

/**
 * 把 SDK 的 step 事件转成平台 StepTrace。
 */
export function stepEventToTrace(
  ev: any,
  riskMap: Map<string, "safe" | "write" | "destructive">,
  confirmedSet: Set<string>,
  rejectedSet: Set<string>,
): StepTrace {
  const toolCalls: StepTrace["toolCalls"] = ((ev?.toolCalls ?? []) as any[]).map((tc, i) => {
    const isDynamic = typeof tc?.type === "string" && tc.type.startsWith("dynamic");
    const toolName = isDynamic
      ? (tc.toolName ?? "unknown")
      : keyToToolName(tc.toolName ?? "unknown");
    const result = ev?.toolResults?.[i] ?? {};
    const id: string = tc?.id ?? `tc_${i}`;
    return {
      id,
      toolName,
      args: (tc?.input ?? tc?.args ?? {}) as Record<string, unknown>,
      result: result?.output ?? result?.result,
      risk: riskMap.get(toolName),
      confirmed: confirmedSet.has(id),
      rejected: rejectedSet.has(id),
      durationMs: 0,
    };
  });

  const inputTokens: number = ev?.usage?.inputTokens ?? 0;
  const outputTokens: number = ev?.usage?.outputTokens ?? 0;
  return {
    stepNumber: ev?.stepNumber ?? 0,
    thought: ev?.text || undefined,
    reasoning: ev?.reasoningText || undefined,
    toolCalls,
    finishReason: ev?.finishReason ?? "unknown",
    usage: {
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      totalTokens: inputTokens + outputTokens,
    },
    durationMs: 0,
  };
}

/**
 * 发射步骤 phase 事件（前端可见的步骤进度）。
 */
export async function emitStepPhase(
  emit: EmitFn | undefined,
  stepNumber: number,
  state: "running" | "done",
): Promise<void> {
  if (!emit) return;
  await emit({
    type: "phase",
    channel: "status",
    payload: phasePayload(
      `react_step_${stepNumber}`,
      `ReAct 第 ${stepNumber + 1} 步`,
      state,
    ),
  });
}

/**
 * 累积 stepTrace 列表（O 层）。
 * 简单封装，便于 harness 在 onStepFinish 回调里追加并汇总 token。
 */
export class TraceAccumulator {
  private readonly traces: StepTrace[] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;

  push(trace: StepTrace): void {
    this.traces.push(trace);
    if (trace.usage) {
      this.inputTokens += trace.usage.inputTokens ?? 0;
      this.outputTokens += trace.usage.outputTokens ?? 0;
      this.totalTokens += trace.usage.totalTokens ?? 0;
    }
  }

  get list(): StepTrace[] {
    return this.traces;
  }

  get usage() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
    };
  }
}
