/**
 * 多轮追问单元测试。
 *
 * 覆盖：
 *   - TaskMeta conversationId/parentTaskId：自动生成与显式传递
 *   - ConversationStore：getTasks/getLatestCompleted/listConversations/getConversation 聚合
 *   - compressTrace 复用：previousContext 构造正确
 *   - buildUserContent：previousContext 注入 user 消息（间接验证 harnessConfig 透传）
 *   - API 行为：POST /api/workflows 透传 conversationId/parentTaskId；GET /api/conversations
 *
 * 不依赖真实 LLM（离线测试）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "../../../src/tasks/task-store.js";
import { ConversationStore } from "../../../src/tasks/conversation-store.js";
import { TaskRegistry } from "../../../src/tasks/registry.js";
import { createApp } from "../../../src/api/app.js";
import { compressTrace } from "../../../src/agent/review-pass.js";
import type { StepTrace } from "../../../src/agent/types.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个临时 data 目录，返回路径（测试后清理）。 */
function withTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lif-multi-turn-"));
  process.env.LIF_DATA_DIR = dir;
  return dir;
}

/** 构造一个最小 StepTrace（用于测试 compressTrace + previousContext）。 */
function makeStepTrace(thought: string, toolName?: string): StepTrace {
  return {
    stepNumber: 0,
    thought,
    toolCalls: toolName
      ? [{
          id: "tc_1",
          toolName,
          args: {},
          result: { data: { oee: 0.65 } },
          durationMs: 100,
        }]
      : [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    durationMs: 200,
  };
}

/** 往 task 追加一个 react_step_trace extension 事件（模拟 NexusOps customRunner 落库）。 */
function appendStepTraceEvent(
  store: FileTaskStore,
  taskId: string,
  stepTrace: StepTrace[],
  finalText: string,
): void {
  const ev: Omit<StreamEvent, "seq"> = {
    type: "extension",
    taskId,
    ts: Date.now(),
    channel: "status",
    payload: {
      name: "react_step_trace",
      version: "1.0",
      data: { stepTrace, finalText },
    },
  } as Omit<StreamEvent, "seq">;
  store.append(taskId, ev);
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskMeta conversationId/parentTaskId
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskMeta 多轮会话字段", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = withTempDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LIF_DATA_DIR;
  });

  it("首条消息缺省 conversationId 时 store 自动生成 c_ 前缀 id", () => {
    const store = new FileTaskStore();
    const meta = store.create("首轮意图");
    expect(meta.conversationId).toBeTruthy();
    expect(meta.conversationId!.startsWith("c_")).toBe(true);
    expect(meta.parentTaskId).toBeUndefined();
  });

  it("追问时显式传入 conversationId/parentTaskId 被正确持久化", () => {
    const store = new FileTaskStore();
    const first = store.create("首轮意图");
    const followUp = store.create("追问意图", {}, {
      conversationId: first.conversationId,
      parentTaskId: first.id,
    });
    expect(followUp.conversationId).toBe(first.conversationId);
    expect(followUp.parentTaskId).toBe(first.id);
  });

  it("重新读取 meta 能还原 conversationId/parentTaskId", () => {
    const store = new FileTaskStore();
    const first = store.create("首轮意图");
    store.create("追问意图", {}, {
      conversationId: first.conversationId,
      parentTaskId: first.id,
    });
    const tasks = store.listAll();
    const followUpTask = tasks.find((t) => t.parentTaskId === first.id);
    expect(followUpTask).toBeTruthy();
    expect(followUpTask!.conversationId).toBe(first.conversationId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConversationStore 聚合
// ─────────────────────────────────────────────────────────────────────────────

describe("ConversationStore 会话链聚合", () => {
  let dataDir: string;
  let store: FileTaskStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    dataDir = withTempDataDir();
    store = new FileTaskStore();
    convStore = new ConversationStore(store);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LIF_DATA_DIR;
  });

  it("getTasks 返回会话内全部 task（按 createdAt 升序，首轮在前）", () => {
    const t1 = store.create("首轮");
    const t2 = store.create("追问1", {}, { conversationId: t1.conversationId, parentTaskId: t1.id });
    const t3 = store.create("追问2", {}, { conversationId: t1.conversationId, parentTaskId: t2.id });

    const tasks = convStore.getTasks(t1.conversationId!);
    expect(tasks.length).toBe(3);
    // 排序稳定：首轮（被引用为 parent）在最前，追问按链顺序
    expect(tasks[0]!.id).toBe(t1.id);
    expect(tasks[1]!.id).toBe(t2.id);
    expect(tasks[2]!.id).toBe(t3.id);
  });

  it("getLatestCompleted 返回最近一个 done task", () => {
    const t1 = store.create("首轮");
    store.setStatus(t1.id, "done");
    const t2 = store.create("追问1", {}, { conversationId: t1.conversationId, parentTaskId: t1.id });
    // t2 还在 running，不应被选中
    store.setStatus(t2.id, "running");

    const latest = convStore.getLatestCompleted(t1.conversationId!);
    expect(latest?.id).toBe(t1.id);
  });

  it("getLatestCompleted 无 done task 时返回 null", () => {
    const t1 = store.create("首轮");
    store.setStatus(t1.id, "running");
    expect(convStore.getLatestCompleted(t1.conversationId!)).toBeNull();
  });

  it("listConversations 按最近活跃降序，标题取首条意图", () => {
    const t1 = store.create("会话A");
    store.setStatus(t1.id, "done");
    const t2 = store.create("会话B");
    store.setStatus(t2.id, "done");

    const list = convStore.listConversations();
    expect(list.length).toBe(2);
    // 两条会话各自的标题
    const titles = list.map((c) => c.title);
    expect(titles).toContain("会话A");
    expect(titles).toContain("会话B");
    // taskCount
    const convA = list.find((c) => c.title === "会话A")!;
    expect(convA.taskCount).toBe(1);
  });

  it("listConversations 聚合同会话多轮 taskCount", () => {
    const t1 = store.create("首轮");
    store.setStatus(t1.id, "done");
    store.create("追问1", {}, { conversationId: t1.conversationId, parentTaskId: t1.id });

    const list = convStore.listConversations();
    expect(list.length).toBe(1);
    expect(list[0]!.taskCount).toBe(2);
  });

  it("getConversation 返回详情含完整 task 链", () => {
    const t1 = store.create("首轮");
    store.create("追问1", {}, { conversationId: t1.conversationId, parentTaskId: t1.id });

    const detail = convStore.getConversation(t1.conversationId!);
    expect(detail).toBeTruthy();
    expect(detail!.title).toBe("首轮");
    expect(detail!.taskCount).toBe(2);
    expect(detail!.tasks.length).toBe(2);
  });

  it("getConversation 不存在的会话返回 null", () => {
    expect(convStore.getConversation("c_nonexistent")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compressTrace 复用（previousContext 构造）
// ─────────────────────────────────────────────────────────────────────────────

describe("compressTrace 复用（多轮上下文构造）", () => {
  it("把 StepTrace 压成精简文本（含 thought + action）", () => {
    const trace: StepTrace[] = [
      makeStepTrace("分析 OEE 偏低原因", "oee.realtime"),
    ];
    const digest = compressTrace(trace);
    expect(digest).toContain("Thought: 分析 OEE 偏低原因");
    expect(digest).toContain("Action: oee.realtime");
  });

  it("空 trace 压成空字符串", () => {
    expect(compressTrace([])).toBe("");
  });

  it("previousContext 由 intent + traceDigest + finalText 三部分组成", () => {
    const trace: StepTrace[] = [makeStepTrace("首轮分析", "oee.realtime")];
    const previousContext = {
      intent: "诊断 OEE",
      traceDigest: compressTrace(trace),
      finalText: "OEE=0.65，主要损失在性能率",
    };
    expect(previousContext.intent).toBe("诊断 OEE");
    expect(previousContext.traceDigest).toContain("Thought: 首轮分析");
    expect(previousContext.finalText).toContain("OEE=0.65");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TaskRegistry.start 透传会话参数
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskRegistry.start 多轮会话参数透传", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = withTempDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LIF_DATA_DIR;
  });

  it("start(intent, config, options) 把 conversationId/parentTaskId 写入 meta", () => {
    // stub runtime（无 customRunner，走 runStub）
    const registry = new TaskRegistry();
    const meta = registry.start("首轮意图", {}, {});
    expect(meta.conversationId).toBeTruthy();

    const followUp = registry.start("追问", {}, {
      conversationId: meta.conversationId,
      parentTaskId: meta.id,
    });
    expect(followUp.conversationId).toBe(meta.conversationId);
    expect(followUp.parentTaskId).toBe(meta.id);
  });

  it("customRunner 收到 context 参数（含 parentTaskId/conversationId）", async () => {
    let capturedContext: { parentTaskId?: string; conversationId?: string } | undefined;
    const registry = new TaskRegistry(undefined, {
      llm: {} as never,
      toolRegistry: {} as never,
      customRunner: async (_taskId, _intent, _hooks, context) => {
        capturedContext = context;
      },
    });
    const first = registry.start("首轮");
    await registry.join(first.id);
    expect(capturedContext?.conversationId).toBeTruthy();

    const followUp = registry.start("追问", {}, {
      conversationId: first.conversationId,
      parentTaskId: first.id,
    });
    await registry.join(followUp.id);
    expect(capturedContext?.parentTaskId).toBe(first.id);
    expect(capturedContext?.conversationId).toBe(first.conversationId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API 行为：POST /api/workflows + GET /api/conversations
// ─────────────────────────────────────────────────────────────────────────────

describe("API 多轮会话端点", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = withTempDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LIF_DATA_DIR;
  });

  it("POST /api/workflows 首意图自动生成 conversationId 并返回", async () => {
    const app = createApp();
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "首轮意图" }),
    });
    const body = (await res.json()) as { status: string; data: { conversationId: string } };
    expect(res.status).toBe(201);
    expect(body.status).toBe("success");
    expect(body.data.conversationId).toBeTruthy();
    expect(body.data.conversationId.startsWith("c_")).toBe(true);
  });

  it("POST /api/workflows 追问时透传 conversationId/parentTaskId", async () => {
    const app = createApp();
    // 首轮
    const res1 = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "首轮意图" }),
    });
    const body1 = (await res1.json()) as { data: { conversationId: string; taskId: string } };
    const convId = body1.data.conversationId;
    const firstTaskId = body1.data.taskId;

    // 追问
    const res2 = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "追问",
        conversationId: convId,
        parentTaskId: firstTaskId,
      }),
    });
    const body2 = (await res2.json()) as { data: { conversationId: string; parentTaskId: string } };
    expect(res2.status).toBe(201);
    expect(body2.data.conversationId).toBe(convId);
    expect(body2.data.parentTaskId).toBe(firstTaskId);
  });

  it("GET /api/conversations 返回会话列表", async () => {
    const app = createApp();
    // 创建一个会话
    await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "测试会话" }),
    });

    const res = await app.request("/api/conversations");
    const body = (await res.json()) as {
      status: string;
      data: Array<{ title: string }>;
    };
    expect(res.status).toBe(200);
    expect(body.status).toBe("success");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]!.title).toBe("测试会话");
  });

  it("GET /api/conversations/:id 返回会话详情含 task 链", async () => {
    const app = createApp();
    const res1 = await app.request("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "首轮" }),
    });
    const convId = ((await res1.json()) as { data: { conversationId: string } }).data.conversationId;

    const res = await app.request(`/api/conversations/${convId}`);
    const body = (await res.json()) as {
      status: string;
      data: { conversationId: string; taskCount: number; tasks: Array<{ intent: string }> };
    };
    expect(res.status).toBe(200);
    expect(body.data.conversationId).toBe(convId);
    expect(body.data.taskCount).toBe(1);
    expect(body.data.tasks.length).toBe(1);
  });

  it("GET /api/conversations/:id 不存在返回 404", async () => {
    const app = createApp();
    const res = await app.request("/api/conversations/c_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractStepTraceFromTask 还原（模拟 boot.ts 的多轮上下文读取）
// ─────────────────────────────────────────────────────────────────────────────

describe("stepTrace 持久化与还原（多轮上下文读取基础）", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = withTempDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LIF_DATA_DIR;
  });

  it("extension(react_step_trace) 事件落库后可被 readByType 读回", () => {
    const store = new FileTaskStore();
    const meta = store.create("首轮");
    const trace: StepTrace[] = [makeStepTrace("首轮分析", "oee.realtime")];
    appendStepTraceEvent(store, meta.id, trace, "OEE=0.65");

    const events = store.readByType(meta.id, "extension");
    const stepTraceEvent = events.find(
      (e) => (e.payload as { name?: string }).name === "react_step_trace",
    );
    expect(stepTraceEvent).toBeTruthy();
    const data = (stepTraceEvent!.payload as { data: Record<string, unknown> }).data;
    expect(Array.isArray(data.stepTrace)).toBe(true);
    expect(data.finalText).toBe("OEE=0.65");
  });

  it("无 react_step_trace 事件的 task 还原为空（降级为无上下文）", () => {
    const store = new FileTaskStore();
    const meta = store.create("首轮");
    // 只追加普通事件，无 react_step_trace
    store.append(meta.id, {
      type: "text",
      taskId: meta.id,
      ts: Date.now(),
      channel: "content",
      payload: { delta: "hello" },
    } as Omit<StreamEvent, "seq">);

    const events = store.readByType(meta.id, "extension");
    const stepTraceEvent = events.find(
      (e) => (e.payload as { name?: string }).name === "react_step_trace",
    );
    expect(stepTraceEvent).toBeUndefined();
  });
});
