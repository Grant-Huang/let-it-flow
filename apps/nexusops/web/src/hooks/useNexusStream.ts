import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvent,
  createInitialStreamState,
  isCompatibleVersion,
  parseSSELine,
} from "@meso.ai/ui/runtime";
import type { StreamState } from "@meso.ai/types";
import type { Message } from "@meso.ai/ui";
import {
  createWorkflow,
  confirmTask,
  clarifyTask,
  getConversation,
  getTask,
  type ConfirmDecision,
} from "../lib/api.js";

/**
 * 拉取单个 task 的全部事件流（since=0），归约到给定的 state，返回最终 state。
 *
 * 纯函数式：不修改外部 stateRef，调用方决定如何使用返回值。
 * 不自行 abort；由调用方持有 AbortController 决定何时中断。
 *
 * @param taskId   任务 id
 * @param signal   AbortSignal
 * @param initial  初始 state（通常 createInitialStreamState()）
 * @returns        归约后的最终 state
 */
async function drainTaskToState(
  taskId: string,
  signal: AbortSignal,
  initial: StreamState,
): Promise<StreamState> {
  const resp = await fetch(`/api/tasks/${taskId}/stream?since=0`, { signal });
  if (!resp.ok || !resp.body) {
    throw new Error(`SSE 连接失败: HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let state = initial;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSSELine(line);
      if (!event || !isCompatibleVersion(event)) continue;
      state = applyEvent(state, event);
    }
  }
  return state;
}

/** 从 StreamState 的 text 事件中提取本轮 AI 回答的完整文本。 */
function extractAssistantText(s: StreamState): string {
  return (s.textContent ?? "").trim();
}

/**
 * 把单个 task 的重放结果构造成一对历史消息（user 提问 + assistant 回答）。
 *
 * - user 消息：task intent
 * - assistant 消息：AI 文本 + trace 快照（让 MessageList 用 blend 路径渲染工具+文本交错）
 *
 * assistant 文本为空时仍保留消息（带 trace），让工具调用轨迹可见。
 */
function buildTurnMessages(taskId: string, intent: string, state: StreamState): Message[] {
  const ts = new Date().toISOString();
  const assistantText = extractAssistantText(state);
  const assistant: Message = {
    id: `a-${taskId}`,
    role: "assistant",
    content: assistantText,
    timestamp: ts,
    trace: state,
  };
  return [
    { id: `u-${taskId}`, role: "user", content: intent, timestamp: ts },
    assistant,
  ];
}

/**
 * NexusOps 流式会话 hook（无 auth，单用户本地使用）。
 *
 * 两阶段 API：
 *  1. POST /api/workflows  → 创建任务，拿到 taskId
 *  2. GET  /api/tasks/:id/stream?since=0  → SSE 订阅，逐行 parseSSELine + applyEvent
 *
 * 状态由 meso StreamState 纯函数归约，驱动 MessageList 实时渲染 ReAct 步骤。
 */
export function useNexusStream() {
  const [state, setState] = useState<StreamState>(createInitialStreamState);
  const [taskId, setTaskId] = useState<string | null>(null);
  /** 多轮追问：当前会话 id（首轮 done 后从响应中保存，追问时透传） */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef<StreamState>(state);
  /** 最近一次完成轮的 taskId（追问时作为 parentTaskId） */
  const lastDoneTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /** 订阅 SSE 流并归约状态。内部共享逻辑（start/followUp 复用）。 */
  const subscribe = useCallback(async (createdTaskId: string, ctrl: AbortController) => {
    try {
      const resp = await fetch(`/api/tasks/${createdTaskId}/stream?since=0`, {
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE 连接失败: HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseSSELine(line);
          if (!event || !isCompatibleVersion(event)) continue;
          const next = applyEvent(stateRef.current, event);
          stateRef.current = next;
          setState(next);
          if (event.type === "done") {
            lastDoneTaskIdRef.current = createdTaskId;
            abortRef.current?.abort();
            return;
          }
          if (event.type === "error") {
            abortRef.current?.abort();
            return;
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState((prev) => ({ ...prev, status: "error", errorMessage: msg }));
    }
  }, []);

  /** 创建任务并订阅 SSE 流（首意图，不传 conversationId）。 */
  const start = useCallback(async (intent: string, config?: object) => {
    abortRef.current?.abort();
    setError(null);
    // 首意图：重置会话上下文
    setConversationId(null);
    lastDoneTaskIdRef.current = null;

    let createdTaskId: string;
    let createdConvId: string | undefined;
    try {
      const created = await createWorkflow(intent, { config });
      createdTaskId = created.taskId;
      createdConvId = created.conversationId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setTaskId(createdTaskId);
    if (createdConvId) setConversationId(createdConvId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = { ...createInitialStreamState(), status: "streaming" as const };
    stateRef.current = fresh;
    setState(fresh);

    await subscribe(createdTaskId, ctrl);
  }, [subscribe]);

  /** 多轮追问：基于当前会话上下文继续提问。 */
  const followUp = useCallback(async (intent: string, config?: object) => {
    if (!conversationId) {
      // 无活跃会话时退化为首意图
      return start(intent, config);
    }
    abortRef.current?.abort();
    setError(null);

    let createdTaskId: string;
    try {
      const created = await createWorkflow(intent, {
        config,
        conversationId,
        parentTaskId: lastDoneTaskIdRef.current ?? undefined,
      });
      createdTaskId = created.taskId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setTaskId(createdTaskId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = { ...createInitialStreamState(), status: "streaming" as const };
    stateRef.current = fresh;
    setState(fresh);

    await subscribe(createdTaskId, ctrl);
  }, [conversationId, subscribe, start]);

  /** HITL 确认门 */
  const confirm = useCallback(
    (decision: ConfirmDecision["decision"], params?: Record<string, unknown>) => {
      if (!taskId) return Promise.resolve();
      return confirmTask(taskId, { decision, params });
    },
    [taskId],
  );

  /** Guardrail 澄清 */
  const clarify = useCallback(
    (message: string) => {
      if (!taskId) return Promise.resolve();
      return clarifyTask(taskId, message);
    },
    [taskId],
  );

  /**
   * 重放历史任务的全部事件，重建 StreamState。
   *
   * @returns 重建的历史消息（user 提问 + assistant 回答）；出错或中止返回空数组
   */
  const replay = useCallback(async (existingTaskId: string): Promise<Message[]> => {
    abortRef.current?.abort();
    setError(null);
    setTaskId(existingTaskId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = createInitialStreamState();
    stateRef.current = fresh;
    setState(fresh);

    // 取 task intent（恢复用户提问文字）
    let intent = "";
    try {
      const meta = await getTask(existingTaskId);
      intent = meta.intent;
    } catch {
      // 取 intent 失败不阻断重放（降级为空提问文字）
    }

    try {
      const finalState = await drainTaskToState(existingTaskId, ctrl.signal, fresh);
      stateRef.current = finalState;
      setState(finalState);
      // 重建历史消息：user 提问 + assistant 回答（带 trace 快照）
      return intent ? buildTurnMessages(existingTaskId, intent, finalState) : [];
    } catch (e) {
      if (ctrl.signal.aborted) return [];
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      return [];
    }
  }, []);

  /**
   * 重放整个会话：依次拉取会话内全部 task 的事件流，按会话顺序重建历史消息
   * （首轮在前，追问轮在后），恢复 conversationId 与 lastDoneTaskId，
   * 使后续追问能在该会话上下文上继续。
   *
   * @returns 重建的全部历史消息（每轮 user 提问 + assistant 回答交错）
   */
  const replayConversation = useCallback(async (existingConversationId: string): Promise<Message[]> => {
    abortRef.current?.abort();
    setError(null);

    let tasks: { id: string; intent: string; status: string }[] = [];
    try {
      const detail = await getConversation(existingConversationId);
      // 保留 intent 字段（用于恢复用户提问文字）
      tasks = detail.tasks.map((t) => ({ id: t.id, intent: t.intent, status: t.status }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
    if (tasks.length === 0) return [];

    // 恢复会话上下文：让后续追问能继续挂在该 conversationId 上
    setConversationId(existingConversationId);
    // 最新一个 done task 作为后续追问的 parentTaskId
    const latestDone = [...tasks].reverse().find((t) => t.status === "done");
    lastDoneTaskIdRef.current = latestDone?.id ?? null;
    // 当前 taskId 设为最新一条（让 UI / HITL 路由定位到会话末轮）
    const lastTask = tasks[tasks.length - 1]!;
    setTaskId(lastTask.id);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = createInitialStreamState();
    stateRef.current = fresh;
    setState(fresh);

    const historyMessages: Message[] = [];
    try {
      for (const t of tasks) {
        // 顺序回放每个 task；任一被外部 abort 即停止
        if (ctrl.signal.aborted) return historyMessages;
        // 每个 task 独立 state，保留轮次边界（user 提问 + assistant 回答）
        const turnState = await drainTaskToState(t.id, ctrl.signal, createInitialStreamState());
        historyMessages.push(...buildTurnMessages(t.id, t.intent, turnState));
      }
      // 最后一轮的 state 作为当前 state（让 streaming 区展示最新一轮）
      if (tasks.length > 0) {
        const lastTurnState = historyMessages.length > 0
          ? historyMessages[historyMessages.length - 1]!.trace
          : undefined;
        if (lastTurnState) {
          stateRef.current = lastTurnState;
          setState(lastTurnState);
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return historyMessages;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
    return historyMessages;
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    const fresh = createInitialStreamState();
    stateRef.current = fresh;
    setState(fresh);
    setTaskId(null);
    setConversationId(null);
    lastDoneTaskIdRef.current = null;
    setError(null);
  }, []);

  const isStreaming = state.status === "streaming";

  return {
    state,
    taskId,
    conversationId,
    error,
    isStreaming,
    start,
    followUp,
    replay,
    replayConversation,
    confirm,
    clarify,
    abort,
    reset,
  };
}
