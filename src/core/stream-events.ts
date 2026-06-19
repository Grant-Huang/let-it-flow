import type {
  SSEEvent,
  PhasePayload,
  TextPayload,
  ToolCallPayload,
  ToolResultPayload,
  ToolStatusPayload,
  WorkflowNodePayload,
  ErrorPayload,
  ExtensionPayload,
} from "@meso.ai/types";

/**
 * 后端事件通道：决定 coalescer 的合并策略（见 08 §8.6）。后端内部簿记字段，
 * 不进入 SSE 协议信封（协议信封见 toSSE()）。
 * - content：高频可合并（token 增量，如 text/tool 输出流）
 * - status：状态变更，立即落库
 * - meta：元信息（done/error），立即落库
 */
export type EventChannel = "content" | "status" | "meta";

/**
 * 内部事件 → 对应 @meso.ai/types payload 的映射表。
 * 这是 toSSE() 类型安全的依据：每个 type 严格绑定一种 payload 形状。
 *
 * HITL 确认（v2.0 协议）：
 *  - 风险工具门控用 tool_call(risk=write/destructive 或 requires_confirm=true)
 *    + tool_status(awaiting_confirm) + 延后的 tool_result
 *    （前端 ToolCallStatus 含 'awaiting_confirm'，ConfirmGate 自动渲染）
 *  - 通用节点确认门用 extension(name="confirm_gate")（节点级确认，非工具级）
 */
export interface EventTypePayloadMap {
  phase: PhasePayload;
  tool_call: ToolCallPayload;
  tool_status: ToolStatusPayload;
  tool_result: ToolResultPayload;
  text: TextPayload;
  workflow_node: WorkflowNodePayload;
  done: Record<string, never>;
  error: ErrorPayload;
  extension: ExtensionPayload;
}

export type StreamEventType = keyof EventTypePayloadMap;

export const STREAM_EVENT_TYPES: readonly StreamEventType[] = [
  "phase",
  "tool_call",
  "tool_status",
  "tool_result",
  "text",
  "workflow_node",
  "done",
  "error",
  "extension",
] as const;

/** 某类型的内部事件（带簿记字段 seq/taskId/ts/channel）。 */
export interface InternalEvent<T extends StreamEventType = StreamEventType> {
  type: T;
  seq: number;
  taskId: string;
  ts: number;
  channel: EventChannel;
  payload: EventTypePayloadMap[T];
}

/** 兼容旧名。 */
export type StreamEvent = InternalEvent;

/** 工具产出的事件形态：不含簿记字段（seq/taskId/ts），由 executor 在 emit 时补齐。 */
export type ToolEvent = Omit<StreamEvent, "seq" | "taskId" | "ts">;

/** 事件发射函数签名（payload 形状由调用方 typed helper 保证）。 */
export type EmitFn = (
  type: StreamEventType,
  payload: Record<string, unknown>,
  channel?: EventChannel,
) => Promise<void>;

/** 按类型推断通道（content 可合并，status/meta 立即落库）。 */
export function channelOf(type: StreamEventType): EventChannel {
  switch (type) {
    case "text":
      return "content";
    case "done":
    case "error":
      return "meta";
    default:
      return "status";
  }
}

/**
 * 构造一个内部事件（不含 seq，由 store 赋序）。payload 形状由调用方保证。
 */
export function makeEvent<T extends StreamEventType>(
  taskId: string,
  type: T,
  payload: EventTypePayloadMap[T],
  channel?: EventChannel,
): Omit<InternalEvent<T>, "seq"> {
  return {
    type,
    taskId,
    ts: Date.now(),
    channel: channel ?? channelOf(type),
    payload,
  } as Omit<InternalEvent<T>, "seq">;
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型化的 payload 构造 helper —— 保证 payload 形状与 @meso.ai/types 协议一致
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 phase payload（v2.0：替代旧 stage）。
 * state 映射：旧 active → 新 running；done/error 不变。
 */
export function phasePayload(
  id: string,
  name: string,
  state: "running" | "done" | "error" | "pending",
): PhasePayload {
  return { id, name, state };
}

export const textPayload = (delta: string): TextPayload => ({ delta });

export const toolCallPayload = (p: ToolCallPayload): ToolCallPayload => p;

export const toolStatusPayload = (p: ToolStatusPayload): ToolStatusPayload => p;

export const toolResultPayload = (p: ToolResultPayload): ToolResultPayload => p;

export const workflowNodePayload = (p: WorkflowNodePayload): WorkflowNodePayload => p;

export const errorPayload = (message: string, code?: string): ErrorPayload =>
  code ? { message, code } : { message };

/**
 * HITL 节点确认门：用 extension 事件携带 confirm_gate 数据。
 *
 * v2.0 协议中工具级确认已标准化为 tool_call.requires_confirm + tool_status(awaiting_confirm)，
 * 但 podcast DAG 的节点级确认（如 fetch 节点抓取前确认）不是工具调用，仍需 extension 承载。
 */
export const confirmGatePayload = (p: {
  gate_id: string;
  node_id: string;
  run_id: string;
  prompt: string;
  options: string[];
  detail?: Record<string, unknown>;
}): ExtensionPayload => ({
  name: "confirm_gate",
  version: "1.0",
  data: p,
});

// ─────────────────────────────────────────────────────────────────────────────
// 后端内部事件 → @meso.ai/types SSE 协议信封
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把后端内部 InternalEvent 转成 @meso.ai/types SSE 协议信封，用于 SSE 出口
 * （GET /tasks/:id/stream）。
 *
 * 协议信封：{ type, schema_version: "1.0", payload }
 * 内部簿记字段（seq/taskId/ts/channel）被剥离 —— 它们只服务后端 store / 断线重连。
 *
 * 类型安全：InternalEvent 的 type/payload 判别联合保证产出合法 SSEEvent。
 */
export function toSSE(event: InternalEvent): SSEEvent {
  return {
    type: event.type,
    schema_version: "1.0",
    payload: event.payload,
  } as SSEEvent;
}

/** 把 SSE 协议信封序列化成 `data: {...}` 的 data 行内容（不含 `data: ` 前缀和 `\n\n`）。 */
export function serializeSSEData(event: InternalEvent): string {
  return JSON.stringify(toSSE(event));
}

// 重新导出常用协议类型，供 api / tools / executor 层直接引用
export type {
  SSEEvent,
  PhaseEvent,
  PhasePayload,
  TextEvent,
  TextPayload,
  ToolCallEvent,
  ToolCallPayload,
  ToolResultEvent,
  ToolResultPayload,
  ToolStatusEvent,
  ToolStatusPayload,
  WorkflowNodeEvent,
  WorkflowNodePayload,
  WorkflowNodeState,
  DoneEvent,
  ErrorEvent,
  ErrorPayload,
  ExtensionEvent,
  ExtensionPayload,
} from "@meso.ai/types";
