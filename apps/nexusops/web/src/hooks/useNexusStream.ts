import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvent,
  createInitialStreamState,
  isCompatibleVersion,
  parseSSELine,
} from "@meso.ai/ui/runtime";
import type { StreamState } from "@meso.ai/types";
import { createWorkflow, confirmTask, clarifyTask, type ConfirmDecision } from "../lib/api.js";

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

  /** 重放历史任务的全部事件，重建 StreamState。 */
  const replay = useCallback(async (existingTaskId: string) => {
    abortRef.current?.abort();
    setError(null);
    setTaskId(existingTaskId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = createInitialStreamState();
    stateRef.current = fresh;
    setState(fresh);

    try {
      const resp = await fetch(`/api/tasks/${existingTaskId}/stream?since=0`, {
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
          if (event.type === "done" || event.type === "error") {
            abortRef.current?.abort();
            return;
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
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
    confirm,
    clarify,
    abort,
    reset,
  };
}
