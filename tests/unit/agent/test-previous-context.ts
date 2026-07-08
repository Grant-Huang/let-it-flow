/**
 * loadPreviousContext 单测（R5 平台基础设施）。
 *
 * 验证多轮追问的上下文读取 + 压缩逻辑（复刻自 NexusOps boot.ts:1022-1047 的 resolvePreviousContext）。
 *
 * 测试策略：
 *   - 用最小化的 MockTaskStore + MockConversationStore，避免依赖真实文件系统
 *   - 覆盖 parentTaskId 显式指定 / conversationId 回退 / 无上下文 / 非 done 状态 / 无 step_trace extension 等分支
 */
import { describe, it, expect } from "vitest";
import { loadPreviousContext, extractStepTraceFromEvents } from "../../../src/agent/previous-context.js";
import { DefaultTraceCompressor } from "../../../src/agent/trace-compressor.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";
import type { TaskMeta } from "../../../src/tasks/task-store.js";

const compressor = new DefaultTraceCompressor();

// ─────────────────────────────────────────────────────────────────────────────
// Mock：最小化的 TaskStore（只需 get + readByType）
// ─────────────────────────────────────────────────────────────────────────────

interface MockStore {
  meta: Map<string, TaskMeta>;
  events: Map<string, StreamEvent[]>;
}

function makeMockStore(): MockStore {
  return { meta: new Map(), events: new Map() };
}

function makeTaskMeta(id: string, over: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id,
    intent: "测试意图",
    status: "done",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  } as TaskMeta;
}

function makeStepTraceEvent(
  stepTrace: unknown[],
  finalText: string,
  name: "step_trace" | "react_step_trace" = "step_trace",
): StreamEvent {
  return {
    type: "extension",
    seq: 1,
    taskId: "t1",
    ts: 1000,
    channel: "status",
    payload: { name, version: "1.0", data: { stepTrace, finalText } },
  } as StreamEvent;
}

// 把 MockStore 包成 loadPreviousContext 需要的形态
function bindStore(store: MockStore) {
  const taskStore = {
    get: (id: string) => store.meta.get(id) ?? null,
    readByType: (id: string, type: string) =>
      (store.events.get(id) ?? []).filter((e) => e.type === type),
  } as unknown as Parameters<typeof loadPreviousContext>[0];

  const conversationStore = {
    getLatestCompleted: (_cid: string) => null,
  } as unknown as Parameters<typeof loadPreviousContext>[1];

  return { taskStore, conversationStore };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractStepTraceFromEvents
// ─────────────────────────────────────────────────────────────────────────────

describe("extractStepTraceFromEvents", () => {
  it("找到 step_trace extension（新 name）→ 还原 stepTrace + finalText", () => {
    const trace = [{ stepNumber: 0, thought: "分析", toolCalls: [] }];
    const ev = [makeStepTraceEvent(trace, "结论")];
    const r = extractStepTraceFromEvents(ev);
    expect(r).not.toBeNull();
    expect(r!.finalText).toBe("结论");
    expect(r!.stepTrace).toEqual(trace);
  });

  it("兼容旧 name react_step_trace（历史 task 数据）", () => {
    const trace = [{ stepNumber: 0, toolCalls: [] }];
    const ev = [makeStepTraceEvent(trace, "旧结论", "react_step_trace")];
    const r = extractStepTraceFromEvents(ev);
    expect(r).not.toBeNull();
    expect(r!.finalText).toBe("旧结论");
  });

  it("无 step_trace / react_step_trace → 返回 null", () => {
    const ev: StreamEvent[] = [
      { type: "extension", seq: 1, taskId: "t1", ts: 1, channel: "status", payload: { name: "other", data: {} } } as StreamEvent,
    ];
    expect(extractStepTraceFromEvents(ev)).toBeNull();
  });

  it("stepTrace 非数组 → 返回 null（容错）", () => {
    const ev = [
      { type: "extension", seq: 1, taskId: "t1", ts: 1, channel: "status", payload: { name: "step_trace", data: { stepTrace: "不是数组", finalText: "x" } } } as StreamEvent,
    ];
    expect(extractStepTraceFromEvents(ev)).toBeNull();
  });

  it("finalText 缺省 → 空字符串", () => {
    const ev = [
      { type: "extension", seq: 1, taskId: "t1", ts: 1, channel: "status", payload: { name: "step_trace", data: { stepTrace: [] } } } as StreamEvent,
    ];
    const r = extractStepTraceFromEvents(ev);
    expect(r).not.toBeNull();
    expect(r!.finalText).toBe("");
  });

  it("多个 step_trace → 取最后一个（最新）", () => {
    const ev = [
      makeStepTraceEvent([{ stepNumber: 0, toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 }], "旧结论"),
      makeStepTraceEvent([{ stepNumber: 0, toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 }, { stepNumber: 1, toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 }], "新结论"),
    ];
    const r = extractStepTraceFromEvents(ev);
    expect(r!.stepTrace).toHaveLength(2);
    expect(r!.finalText).toBe("新结论");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPreviousContext
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPreviousContext", () => {
  it("context 为 undefined → 返回 undefined（首轮）", async () => {
    const store = makeMockStore();
    const { taskStore, conversationStore } = bindStore(store);
    const r = await loadPreviousContext(taskStore, conversationStore, undefined, compressor);
    expect(r).toBeUndefined();
  });

  it("parentTaskId 指向 done task → 返回压缩上下文", async () => {
    const store = makeMockStore();
    store.meta.set("p1", makeTaskMeta("p1", { intent: "上一轮意图" }));
    store.events.set("p1", [makeStepTraceEvent([{ stepNumber: 0, thought: "分析 OEE", toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 }], "OEE 偏低")]);
    const { taskStore, conversationStore } = bindStore(store);

    const r = await loadPreviousContext(taskStore, conversationStore, { parentTaskId: "p1" }, compressor);
    expect(r).toBeDefined();
    expect(r!.intent).toBe("上一轮意图");
    expect(r!.finalText).toBe("OEE 偏低");
    expect(r!.traceDigest).toContain("[Step 0]");
    expect(r!.traceDigest).toContain("分析 OEE");
  });

  it("parentTaskId 指向非 done task → 返回 undefined（失败上下文不喂 LLM）", async () => {
    const store = makeMockStore();
    store.meta.set("p1", makeTaskMeta("p1", { status: "error" }));
    store.events.set("p1", [makeStepTraceEvent([], "")]);
    const { taskStore, conversationStore } = bindStore(store);
    const r = await loadPreviousContext(taskStore, conversationStore, { parentTaskId: "p1" }, compressor);
    expect(r).toBeUndefined();
  });

  it("parentTaskId 指向 done task 但无 step_trace extension → 返回 undefined（兼容旧 task）", async () => {
    const store = makeMockStore();
    store.meta.set("p1", makeTaskMeta("p1"));
    store.events.set("p1", []);
    const { taskStore, conversationStore } = bindStore(store);
    const r = await loadPreviousContext(taskStore, conversationStore, { parentTaskId: "p1" }, compressor);
    expect(r).toBeUndefined();
  });

  it("parentTaskId 不存在（taskStore.get 返回 null）→ 回退到 conversationId", async () => {
    const store = makeMockStore();
    store.meta.set("p2", makeTaskMeta("p2", { intent: "会话上一个" }));
    store.events.set("p2", [makeStepTraceEvent([], "结论")]);
    const { taskStore } = bindStore(store);
    // 覆盖 conversationStore.getLatestCompleted
    const conversationStore = {
      getLatestCompleted: (_cid: string) => store.meta.get("p2"),
    } as unknown as Parameters<typeof loadPreviousContext>[1];

    const r = await loadPreviousContext(taskStore, conversationStore, { conversationId: "conv1" }, compressor);
    expect(r).toBeDefined();
    expect(r!.intent).toBe("会话上一个");
  });

  it("parentTaskId 和 conversationId 都无 → 返回 undefined", async () => {
    const store = makeMockStore();
    const { taskStore, conversationStore } = bindStore(store);
    const r = await loadPreviousContext(taskStore, conversationStore, {}, compressor);
    expect(r).toBeUndefined();
  });
});
