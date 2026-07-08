/**
 * emitHarnessResult / buildSessionSummary 单测（R7 钩子与摘要）。
 *
 * 验证：
 *   - buildSessionSummary 的三种 kind（success / precondition_unmet / error）分支
 *   - extractFinalizeSummary 提取 finalize summary 参数
 *   - emitHarnessResult 的 emit 副作用（构造正确的事件类型 + payload）
 *
 * 策略：用 Mock EmitFn 收集 emit 的事件，验证语义；文案逻辑单独测 buildSessionSummary。
 */
import { describe, it, expect } from "vitest";
import {
  buildSessionSummary,
  extractFinalizeSummary,
  emitHarnessResult,
  type SessionSummaryInput,
} from "../../../src/agent/result-emitter.js";
import type { StepTrace, HarnessResult, EmitFn } from "../../../src/agent/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock EmitFn：收集所有 emit 的事件
// ─────────────────────────────────────────────────────────────────────────────

interface EmittedEvent {
  type: string;
  channel?: string;
  payload: unknown;
}

function makeEmitCollector(): { emit: EmitFn; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const emit: EmitFn = async (event) => {
    events.push({ type: event.type, channel: event.channel, payload: event.payload });
  };
  return { emit, events };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助构造函数
// ─────────────────────────────────────────────────────────────────────────────

function makeFinalizeCall(summary?: string): StepTrace {
  return {
    stepNumber: 0,
    thought: undefined,
    toolCalls: [
      {
        id: "tc1",
        toolName: "nexus_finalize",
        args: summary !== undefined ? { summary } : {},
        result: {},
        durationMs: 0,
      },
    ],
    finishReason: "tool-calls",
    usage: {},
    durationMs: 0,
  };
}

function makeResult(over: Partial<HarnessResult> = {}): HarnessResult {
  return {
    stepTrace: [],
    finalText: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "finalize_tool",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSessionSummary
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSessionSummary", () => {
  describe("error 分支", () => {
    it("emit 中断文字（含截断 + 重试提示）", () => {
      const r = buildSessionSummary({ kind: "error", intent: "x", error: "API timeout" });
      expect(r).toContain("分析中断");
      expect(r).toContain("API timeout");
      expect(r).toContain("可稍后重试");
    });

    it("error 缺省 → 未知错误", () => {
      const r = buildSessionSummary({ kind: "error", intent: "x" });
      expect(r).toContain("未知错误");
    });

    it("error 过长 → 截断到 120 字 + 省略号", () => {
      const long = "E".repeat(300);
      const r = buildSessionSummary({ kind: "error", intent: "x", error: long });
      expect(r).toContain("…");
      expect(r.length).toBeLessThan(long.length);
    });
  });

  describe("precondition_unmet 分支", () => {
    it("无工具调用 → 提示尚未取证", () => {
      const r = buildSessionSummary({ kind: "precondition_unmet", intent: "x", stepTrace: [] });
      expect(r).toContain("证据不足");
      expect(r).toContain("尚未取证");
    });

    it("有工具调用 → 提示已取证次数但不足", () => {
      const trace = [
        { stepNumber: 0, toolCalls: [{ id: "1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }], finishReason: "stop", usage: {}, durationMs: 0 },
        { stepNumber: 1, toolCalls: [{ id: "2", toolName: "equip.downtime", args: {}, result: {}, durationMs: 0 }], finishReason: "stop", usage: {}, durationMs: 0 },
      ] as StepTrace[];
      const r = buildSessionSummary({ kind: "precondition_unmet", intent: "x", stepTrace: trace });
      expect(r).toContain("已取证 2 次");
    });

    it("rejected 工具不计入取证次数", () => {
      const trace = [
        {
          stepNumber: 0,
          toolCalls: [
            { id: "1", toolName: "x", args: {}, result: {}, durationMs: 0 },
            { id: "2", toolName: "y", args: {}, result: {}, rejected: true, durationMs: 0 },
          ],
          finishReason: "stop",
          usage: {},
          durationMs: 0,
        },
      ] as StepTrace[];
      const r = buildSessionSummary({ kind: "precondition_unmet", intent: "x", stepTrace: trace });
      expect(r).toContain("已取证 1 次");
    });
  });

  describe("success 分支", () => {
    it("LLM 已输出 ≥30 字 → 不补（空字符串）", () => {
      const long = "A".repeat(30);
      const r = buildSessionSummary({ kind: "success", intent: "x", finalText: long });
      expect(r).toBe("");
    });

    it("LLM 短输出 + 有 finalize summary → 用 summary", () => {
      const r = buildSessionSummary({
        kind: "success",
        intent: "x",
        finalText: "短",
        finalizeSummary: "LLM 自己写的结论摘要",
      });
      expect(r).toContain("LLM 自己写的结论摘要");
    });

    it("LLM 无输出 + 无 summary + 无工具调用 → 空（澄清反问等）", () => {
      const r = buildSessionSummary({ kind: "success", intent: "x", finalText: "", stepTrace: [] });
      expect(r).toBe("");
    });

    it("LLM 无输出 + 有工具调用 → 最小兜底", () => {
      const trace: StepTrace[] = [
        { stepNumber: 0, toolCalls: [{ id: "1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }], finishReason: "stop", usage: {}, durationMs: 0 },
      ];
      const r = buildSessionSummary({ kind: "success", intent: "x", finalText: "", stepTrace: trace });
      expect(r).toContain("分析结束");
    });

    it("finishReason=step_count → 兜底文字含步数上限标记", () => {
      const trace: StepTrace[] = [
        { stepNumber: 0, toolCalls: [{ id: "1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }], finishReason: "stop", usage: {}, durationMs: 0 },
      ];
      const r = buildSessionSummary({
        kind: "success",
        intent: "x",
        finalText: "",
        finalizeSummary: "",
        finishReason: "step_count",
        stepTrace: trace,
      });
      expect(r).toContain("步数上限");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractFinalizeSummary
// ─────────────────────────────────────────────────────────────────────────────

describe("extractFinalizeSummary", () => {
  it("找到 nexus_finalize 工具调用 → 返回 summary 参数", () => {
    const trace: StepTrace[] = [makeFinalizeCall("最终结论")];
    expect(extractFinalizeSummary(trace)).toBe("最终结论");
  });

  it("兼容 nexus.finalize（点号形态）", () => {
    const trace: StepTrace[] = [
      {
        stepNumber: 0,
        toolCalls: [{ id: "1", toolName: "nexus.finalize", args: { summary: "兼容形态" }, result: {}, durationMs: 0 }],
        finishReason: "tool-calls",
        usage: {},
        durationMs: 0,
      },
    ];
    expect(extractFinalizeSummary(trace)).toBe("兼容形态");
  });

  it("无 finalize 工具 → 返回空字符串", () => {
    const trace: StepTrace[] = [
      { stepNumber: 0, toolCalls: [{ id: "1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }], finishReason: "stop", usage: {}, durationMs: 0 },
    ];
    expect(extractFinalizeSummary(trace)).toBe("");
  });

  it("summary 为空字符串 → 返回空字符串", () => {
    const trace: StepTrace[] = [makeFinalizeCall("   ")];
    expect(extractFinalizeSummary(trace)).toBe("");
  });

  it("summary 为非字符串 → 返回空字符串（容错）", () => {
    const trace: StepTrace[] = [
      { stepNumber: 0, toolCalls: [{ id: "1", toolName: "nexus_finalize", args: { summary: 123 }, result: {}, durationMs: 0 }], finishReason: "tool-calls", usage: {}, durationMs: 0 },
    ];
    expect(extractFinalizeSummary(trace)).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emitHarnessResult
// ─────────────────────────────────────────────────────────────────────────────

describe("emitHarnessResult", () => {
  it("finishReason=error → emit text + error 事件", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({ finishReason: "error", error: "boom" });
    await emitHarnessResult({ emit, intent: "x", result });
    // text 事件（兜底文字）
    expect(events.some((e) => e.type === "text")).toBe(true);
    // error 事件
    const errEv = events.find((e) => e.type === "error");
    expect(errEv).toBeDefined();
    expect((errEv!.payload as { message: string }).message).toBe("boom");
  });

  it("finishReason=precondition_unmet → emit text + extension(precondition_unmet)", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({ finishReason: "precondition_unmet", finalText: "证据不足" });
    await emitHarnessResult({ emit, intent: "x", result });
    expect(events.some((e) => e.type === "text")).toBe(true);
    const ext = events.find((e) => e.type === "extension");
    expect(ext).toBeDefined();
    expect((ext!.payload as { name: string }).name).toBe("precondition_unmet");
  });

  it("finishReason=finalize_tool + finalText ≥ 30 → 不 emit text（LLM 已输出）", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({ finishReason: "finalize_tool", finalText: "A".repeat(30) });
    await emitHarnessResult({ emit, intent: "x", result });
    expect(events.some((e) => e.type === "text")).toBe(false);
  });

  it("成功路径 → emit react_result extension", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({
      finishReason: "finalize_tool",
      finalText: "A".repeat(30),
      stepTrace: [{ stepNumber: 0, toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 }],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    await emitHarnessResult({ emit, intent: "x", result });
    const ext = events.find((e) => e.type === "extension" && (e.payload as { name: string }).name === "react_result");
    expect(ext).toBeDefined();
    const data = (ext!.payload as { data: { finishReason: string; stepCount: number; usage: object } }).data;
    expect(data.finishReason).toBe("finalize_tool");
    expect(data.stepCount).toBe(1);
  });

  it("成功路径含 core.deliver → emit artifacts extension（含稳定 id）", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({
      finishReason: "finalize_tool",
      finalText: "A".repeat(30),
      stepTrace: [
        {
          stepNumber: 2,
          toolCalls: [
            {
              id: "tc_deliver_1",
              toolName: "core.deliver",
              args: {},
              result: JSON.stringify({ type: "report_html", title: "OEE 报告" }),
              durationMs: 0,
            },
          ],
          finishReason: "tool-calls",
          usage: {},
          durationMs: 0,
        },
      ],
    });
    await emitHarnessResult({ emit, intent: "x", result });
    const ext = events.find((e) => e.type === "extension" && (e.payload as { name: string }).name === "artifacts");
    expect(ext).toBeDefined();
    const items = (ext!.payload as { data: { items: Array<{ id: string; title: string }> } }).data.items;
    expect(items).toHaveLength(1);
    // 稳定 id：deliver-{stepNumber}-{tcId}
    expect(items[0]!.id).toBe("deliver-2-tc_deliver_1");
    expect(items[0]!.title).toBe("OEE 报告");
  });

  it("core.deliver 自带 id → 优先用 parsed.id", async () => {
    const { emit, events } = makeEmitCollector();
    const result = makeResult({
      finishReason: "finalize_tool",
      finalText: "A".repeat(30),
      stepTrace: [
        {
          stepNumber: 0,
          toolCalls: [
            {
              id: "tc1",
              toolName: "core.deliver",
              args: {},
              result: { id: "report-july", type: "html", title: "7月报告" },
              durationMs: 0,
            },
          ],
          finishReason: "tool-calls",
          usage: {},
          durationMs: 0,
        },
      ],
    });
    await emitHarnessResult({ emit, intent: "x", result });
    const ext = events.find((e) => e.type === "extension" && (e.payload as { name: string }).name === "artifacts");
    const items = (ext!.payload as { data: { items: Array<{ id: string }> } }).data.items;
    expect(items[0]!.id).toBe("report-july");
  });
});
