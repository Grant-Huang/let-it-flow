/**
 * AICF customRunner 失败反馈单测（问题 2/3/4/5）。
 *
 * 通过 vi.mock 替换 runReactHarness，控制其返回的 finishReason，
 * 验证 customRunner 对各终态（step_count / 空 no_tool_call / HITL reject / error）
 * 都会发 error 事件或 extension + setStatus 终态，绝不静默 done。
 *
 * 真实 LLM 全链路留 e2e；这里只验证终态判定逻辑。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessResult } from "../../../../src/agent/types.js";
import type { StreamEvent } from "../../../../src/core/stream-events.js";

// 控制台：runReactHarness 返回值（每个 it 前设置）
let mockResult: HarnessResult;
/** 是否在 mock 执行期间模拟一次 requireConfirmation 调用（用于 HITL reject 测试）。 */
let simulateHitl: boolean = false;
const runReactHarnessMock = vi.fn(async (_intent: string, config: unknown): Promise<HarnessResult> => {
  if (simulateHitl) {
    const cfg = config as { requireConfirmation?: (g: unknown) => Promise<{ approved: boolean }> };
    if (cfg.requireConfirmation) {
      await cfg.requireConfirmation({ prompt: "test", options: ["approve", "reject"] });
    }
  }
  return mockResult;
});

vi.mock("../../../../src/agent/react-harness.js", () => ({
  runReactHarness: (...args: unknown[]) => runReactHarnessMock(...(args as [string, unknown])),
}));

// boot.ts 必须在 vi.mock 之后 import（vi.mock 会 hoist）
import { bootAiContentFactory } from "../../../../apps/ai-content-factory/server/boot.js";
import type { TaskRunnerHooks, TaskRuntime } from "../../../../src/tasks/registry.js";

let dataDir: string;
const savedDataDir = process.env.LIF_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "aicf-fb-"));
  process.env.LIF_DATA_DIR = dataDir;
  mockResult = {
    stepTrace: [],
    finalText: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "no_tool_call",
  };
  runReactHarnessMock.mockClear();
  simulateHitl = false;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.LIF_DATA_DIR;
  else process.env.LIF_DATA_DIR = savedDataDir;
});

/** 收集 hooks.emit / hooks.setStatus 调用，便于断言。 */
function makeCapturingHooks(): {
  hooks: TaskRunnerHooks;
  events: StreamEvent[];
  statuses: { status: string; message?: string }[];
} {
  const events: StreamEvent[] = [];
  const statuses: { status: string; message?: string }[] = [];
  const hooks: TaskRunnerHooks = {
    emit: ((type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload, seq: events.length + 1, taskId: "t", ts: Date.now(), channel: "meta" } as never);
      return undefined;
    }) as never,
    setStatus: ((status: string, message?: string) => {
      statuses.push({ status, message });
    }) as never,
    awaitConfirmation: (() => Promise.resolve({ gateId: "g", approved: true })) as never,
  };
  return { hooks, events, statuses };
}

describe("AICF customRunner 失败反馈", () => {
  it("finishReason=step_count → 发 error 事件 + setStatus(failed)（问题4）", async () => {
    mockResult = { ...mockResult, finishReason: "step_count" };
    const runtime = await bootAiContentFactory({ vaultPath: "" });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "failed" });
    expect(statuses.at(-1)?.message).toContain("步数耗尽");
  });

  it("finishReason=no_tool_call 且无 finalText → 发 error + setStatus(failed)（问题4）", async () => {
    mockResult = { ...mockResult, finishReason: "no_tool_call", finalText: "" };
    const runtime = await bootAiContentFactory({ vaultPath: "" });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "failed" });
  });

  it("finishReason=no_tool_call 且有 finalText → 发 text + done（反问用户合法路径）", async () => {
    mockResult = { ...mockResult, finishReason: "no_tool_call", finalText: "请告诉我更多细节" };
    const runtime = await bootAiContentFactory({ vaultPath: "" });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "done" });
  });

  it("HITL reject → setStatus(aborted) + extension(user_rejected)（问题5）", async () => {
    simulateHitl = true;
    mockResult = { ...mockResult, finishReason: "finalize_tool", finalText: "部分内容" };
    const runtime = await bootAiContentFactory({
      vaultPath: "",
      requireConfirmation: async () => ({ approved: false }),
    });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    const hasUserRejected = events.some(
      (e) => e.type === "extension" && (e.payload as { name?: string }).name === "user_rejected",
    );
    expect(hasUserRejected, "应发 extension(user_rejected)").toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "aborted" });
  });

  it("finishReason=error → 发 error + setStatus(error)（已有路径回归）", async () => {
    mockResult = { ...mockResult, finishReason: "error", error: "LLM 超时" };
    const runtime = await bootAiContentFactory({ vaultPath: "" });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "error", message: "LLM 超时" });
  });

  it("finishReason=finalize_tool → 发 done + setStatus(done)（成功路径回归）", async () => {
    mockResult = { ...mockResult, finishReason: "finalize_tool", finalText: "完成" };
    const runtime = await bootAiContentFactory({ vaultPath: "" });
    const { hooks, events, statuses } = makeCapturingHooks();
    await (runtime.taskRuntime.customRunner as NonNullable<TaskRuntime["customRunner"]>)("t", "意图", hooks);

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: "done" });
  });
});
