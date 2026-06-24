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
 * Podcast 流式会话 hook（无 auth，单用户本地使用）。
 *
 * 两阶段 API（见 docs/14-podcast-generator-frontend.md §14.6.3）：
 *  1. POST /api/workflows  → 创建任务，拿到 taskId
 *  2. GET  /api/tasks/:id/stream?since=0  → SSE 订阅，逐行 parseSSELine + applyEvent
 *
 * 状态由 meso StreamState 纯函数归约，驱动 MessageList 实时渲染。
 */
export function usePodcastStream() {
  const [state, setState] = useState<StreamState>(createInitialStreamState);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // StreamStateRef：流读取循环内同步访问最新状态，避免闭包陈旧值
  const stateRef = useRef<StreamState>(state);

  // 卸载时中止流
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /**
   * 创建任务并订阅 SSE 流。
   * @param intent 用户意图
   * @param config 可选 podcast 配置（pipeline / style / language 等）
   */
  const start = useCallback(async (intent: string, config?: object) => {
    abortRef.current?.abort();
    setError(null);

    let createdTaskId: string;
    try {
      const created = await createWorkflow(intent, config);
      createdTaskId = created.taskId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      const failed = { ...createInitialStreamState(), status: "error" as const, errorMessage: msg };
      stateRef.current = failed;
      setState(failed);
      return;
    }

    setTaskId(createdTaskId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const fresh = { ...createInitialStreamState(), status: "streaming" as const };
    stateRef.current = fresh;
    setState(fresh);

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
      setState((prev) => ({ ...prev, status: "error", errorMessage: msg }));
    }
  }, []);

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
   * 重放历史任务的全部事件，重建 StreamState（用于历史会话查看）。
   * 与 start 不同：不创建新任务，只 GET 已有任务的 since=0 事件流并归约。
   */
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
      const failed = { ...createInitialStreamState(), status: "error" as const, errorMessage: msg };
      stateRef.current = failed;
      setState(failed);
    }
  }, []);

  /** 中断当前流 */
  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 重置会话状态，回到 idle */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    const fresh = createInitialStreamState();
    stateRef.current = fresh;
    setState(fresh);
    setTaskId(null);
    setError(null);
  }, []);

  const isStreaming = state.status === "streaming";

  return { state, taskId, error, isStreaming, start, replay, confirm, clarify, abort, reset };
}
