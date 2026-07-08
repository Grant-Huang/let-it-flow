/**
 * 多轮追问上下文加载（R5 平台基础设施）。
 *
 * 把 NexusOps boot.ts:1022-1071 自实现的 resolvePreviousContext + extractStepTraceFromTask
 * 回归到平台层。应用通过 loadPreviousContext 读取上一轮压缩上下文，注入 HarnessConfig.previousContext。
 *
 * 设计：
 *   - 纯函数，依赖注入 TaskStore + ConversationStore + TraceCompressor（应用可替换）
 *   - 仅 done 状态的 task 可作 parent（避免失败上下文污染）
 *   - 兼容旧 task（无 step_trace extension 时返回 undefined，降级为首轮）
 */
import type { FileTaskStore } from "../tasks/task-store.js";
import type { ConversationStore } from "../tasks/conversation-store.js";
import type { StreamEvent } from "../core/stream-events.js";
import type { StepTrace } from "./types.js";
import type { TraceCompressor, TraceDigest } from "./trace-compressor.js";

/** 上一轮 step_trace extension 事件的载荷（前端不渲染，仅供多轮追问还原）。 */
const STEP_TRACE_LEGACY_NAME = "react_step_trace";

/**
 * 从 task 的事件流还原 stepTrace + finalText。
 *
 * 读取 customRunner 在成功路径落库的 extension(react_step_trace / step_trace) 事件。
 * 兼容旧 task（无此事件）时返回 null（首轮/降级为无上下文）。
 *
 * @param events  task 的全部事件（taskStore.readByType(taskId, "extension")）
 * @returns       还原结果；无匹配事件或 stepTrace 非数组时返回 null
 */
export function extractStepTraceFromEvents(
  events: StreamEvent[],
): { stepTrace: StepTrace[]; finalText: string } | null {
  // 从后往前扫，取最后一个匹配（最新版本）
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const payload = ev.payload as { name?: string; data?: Record<string, unknown> } | undefined;
    // 兼容新旧 name：react_step_trace（旧）/ step_trace（新，R3 迁移后）
    if (payload?.name !== STEP_TRACE_LEGACY_NAME && payload?.name !== "step_trace") continue;
    const data = payload.data ?? {};
    const stepTrace = data.stepTrace;
    const finalText = typeof data.finalText === "string" ? data.finalText : "";
    if (Array.isArray(stepTrace)) {
      return { stepTrace: stepTrace as StepTrace[], finalText };
    }
  }
  return null;
}

/**
 * 加载多轮追问的上一轮压缩上下文。
 *
 * 策略（按优先级，与 NexusOps boot.ts:1022-1047 一致）：
 *   1. context.parentTaskId 显式指定 → 读该 task
 *   2. context.conversationId 存在 → 取会话内最近一个 done task
 *   3. 无 parent（首轮）→ 返回 undefined
 *
 * 仅 done 状态的 task 可作 parent（避免把失败上下文喂给 LLM）。
 *
 * @param taskStore          文件任务存储（get + readByType）
 * @param conversationStore  会话存储（getLatestCompleted）
 * @param context            运行时上下文（parentTaskId / conversationId）
 * @param compressor         轨迹压缩器（默认 DefaultTraceCompressor）
 * @returns                  压缩后的 digest；无可用 parent 时返回 undefined
 */
export async function loadPreviousContext(
  taskStore: Pick<FileTaskStore, "get" | "readByType">,
  conversationStore: Pick<ConversationStore, "getLatestCompleted">,
  context: { parentTaskId?: string; conversationId?: string } | undefined,
  compressor: TraceCompressor,
): Promise<TraceDigest | undefined> {
  if (!context) return undefined;

  // 1. 显式 parentTaskId
  let parentMeta = context.parentTaskId ? taskStore.get(context.parentTaskId) : null;

  // 2. 回退：取会话最近 done task
  if (!parentMeta && context.conversationId) {
    parentMeta = conversationStore.getLatestCompleted(context.conversationId);
  }

  // 3. 仅 done 状态的 task 可作 parent
  if (!parentMeta || parentMeta.status !== "done") return undefined;

  // 4. 从事件流还原 stepTrace
  const events = taskStore.readByType(parentMeta.id, "extension");
  const extracted = extractStepTraceFromEvents(events);
  if (!extracted) return undefined;

  // 5. 压缩并构造 digest
  return compressor.compress(extracted.stepTrace, extracted.finalText, {
    intent: parentMeta.intent,
  });
}
