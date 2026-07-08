/**
 * streamNarrateToolCall + templateNarration 单测（B 方案流式解读）。
 *
 * 测试策略：
 *   - templateNarration：rejected/error/blocked/empty → 模板；EvidenceEnvelope → null
 *   - 自定义 templates 覆盖默认文案
 *   - streamNarrateToolCall 模板分支：onDelta 收到完整模板文本（含换行）
 *   - streamNarrateToolCall LLM 分支：mock streamText，onDelta 逐 delta 收到
 *   - streamNarrateToolCall 无模型 + EvidenceEnvelope → 静默（onDelta 不调）
 *   - streamNarrateToolCall LLM 失败 → 静默降级
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock ai 模块的 streamText（流式版用这个）；generateText 也 mock 避免真实调用
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import {
  templateNarration,
  streamNarrateToolCall,
  DEFAULT_TEMPLATES,
  type NarrationTemplates,
} from "../../../src/agent/narrate-pass.js";
import { fireNarrations } from "../../../src/agent/react-harness.js";
import type { StepTrace } from "../../../src/agent/types.js";

const dummyModel = { specificationVersion: "v1" } as unknown as LanguageModel;

const EVIDENCE_RESULT = {
  data: { oee: 0.62, availability: 0.7 },
  freshness: "realtime",
  capturedAt: "2026-06-29T14:00:00Z",
  confidence: "measured",
  source: { system: "MES", provenance: "/mes/oee" },
};

const mockStreamText = streamText as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockStreamText.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// templateNarration
// ─────────────────────────────────────────────────────────────────────────────

describe("templateNarration", () => {
  it("rejected → 默认模板", () => {
    const r = templateNarration({ toolName: "tool.a", args: {}, result: null, rejected: true });
    expect(r).toBe(DEFAULT_TEMPLATES.rejected("tool.a"));
  });

  it("error → 默认模板（含截断）", () => {
    const r = templateNarration({ toolName: "tool.a", args: {}, result: null, error: "boom" });
    expect(r).toBe(DEFAULT_TEMPLATES.error("tool.a", "boom"));
  });

  it("blocked → 默认模板", () => {
    const r = templateNarration({
      toolName: "tool.a",
      args: {},
      result: { governance_blocked: true, reason: "越界" },
    });
    expect(r).toBe(DEFAULT_TEMPLATES.blocked("tool.a", "治理规则阻断：越界"));
  });

  it("empty → 默认模板", () => {
    const r = templateNarration({ toolName: "tool.a", args: {}, result: {} });
    expect(r).toBe(DEFAULT_TEMPLATES.empty("tool.a"));
  });

  it("EvidenceEnvelope → null（走 LLM）", () => {
    const r = templateNarration({ toolName: "tool.a", args: {}, result: EVIDENCE_RESULT });
    expect(r).toBeNull();
  });

  it("裸对象（非空）→ null（走 LLM 兜底）", () => {
    const r = templateNarration({ toolName: "tool.a", args: {}, result: { foo: "bar" } });
    expect(r).toBeNull();
  });

  it("自定义 templates 覆盖默认文案", () => {
    const custom: NarrationTemplates = {
      rejected: (n) => `⏭ skipped ${n}`,
      empty: (n) => `⚠ ${n} empty`,
    };
    expect(templateNarration({ toolName: "x", args: {}, result: null, rejected: true }, custom)).toBe(
      "⏭ skipped x",
    );
    expect(templateNarration({ toolName: "x", args: {}, result: {} }, custom)).toBe("⚠ x empty");
    // 未自定义的 error 仍用默认
    expect(templateNarration({ toolName: "x", args: {}, result: null, error: "e" }, custom)).toBe(
      DEFAULT_TEMPLATES.error("x", "e"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamNarrateToolCall
// ─────────────────────────────────────────────────────────────────────────────

describe("streamNarrateToolCall 模板分支", () => {
  it("rejected → onDelta 收到完整模板文本 + 换行，不调 streamText", async () => {
    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "tool.a", args: {}, result: null, rejected: true },
      { model: dummyModel, onDelta: async (d) => { deltas.push(d); } },
    );
    expect(deltas).toEqual([`${DEFAULT_TEMPLATES.rejected("tool.a")}\n`]);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it("empty → onDelta 收到模板文本", async () => {
    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "tool.a", args: {}, result: {} },
      { model: dummyModel, onDelta: async (d) => { deltas.push(d); } },
    );
    expect(deltas).toEqual([`${DEFAULT_TEMPLATES.empty("tool.a")}\n`]);
  });

  it("自定义 templates 在流式模式下生效", async () => {
    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "x", args: {}, result: null, rejected: true },
      {
        model: dummyModel,
        onDelta: async (d) => { deltas.push(d); },
        templates: { rejected: (n) => `SKIP ${n}` },
      },
    );
    expect(deltas).toEqual(["SKIP x\n"]);
  });
});

describe("streamNarrateToolCall LLM 分支", () => {
  it("EvidenceEnvelope + streamText 逐 delta → onDelta 逐段收到 + 末尾换行", async () => {
    // mock streamText 返回一个 async iterable
    mockStreamText.mockReturnValue({
      textStream: (async function* () {
        yield "查到 ";
        yield "OEE=0.62";
      })(),
    });

    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "oee.realtime", args: { line: "L01" }, result: EVIDENCE_RESULT },
      { model: dummyModel, onDelta: async (d) => { deltas.push(d); } },
    );
    expect(deltas).toEqual(["查到 ", "OEE=0.62", "\n"]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("compatMode=true → system 折叠进 user 消息", async () => {
    mockStreamText.mockReturnValue({ textStream: (async function* () { yield "ok"; })() });
    await streamNarrateToolCall(
      { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
      { model: dummyModel, compatMode: true, onDelta: async () => {} },
    );
    const callArgs = mockStreamText.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.system).toBeUndefined();
    const messages = callArgs.messages as Array<{ content: string }>;
    expect(messages[0]!.content).toContain("解说员");
    expect(messages[0]!.content).toContain("---");
  });

  it("无模型 + EvidenceEnvelope → 静默（onDelta 不调，streamText 不调）", async () => {
    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
      { onDelta: async (d) => { deltas.push(d); } },
    );
    expect(deltas).toHaveLength(0);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it("streamText 抛错 → 静默降级（onDelta 不调，不抛出）", async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error("stream boom");
    });
    const deltas: string[] = [];
    await expect(
      streamNarrateToolCall(
        { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
        { model: dummyModel, onDelta: async (d) => { deltas.push(d); } },
      ),
    ).resolves.toBeUndefined();
    expect(deltas).toHaveLength(0);
  });

  it("LLM 无输出（空流）→ 不补换行", async () => {
    mockStreamText.mockReturnValue({ textStream: (async function* () {})() });
    const deltas: string[] = [];
    await streamNarrateToolCall(
      { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
      { model: dummyModel, onDelta: async (d) => { deltas.push(d); } },
    );
    expect(deltas).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fireNarrations（react-harness 导出，验证 fire-and-forget 并发语义）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个 StepTrace.toolCalls 元素。 */
function makeToolCall(over: Partial<StepTrace["toolCalls"][number]>): StepTrace["toolCalls"][number] {
  return {
    id: "tc_1",
    toolName: "tool.a",
    args: {},
    result: {},
    durationMs: 0,
    ...over,
  };
}

describe("fireNarrations", () => {
  it("多个工具解读并发跑，emit 收到每个工具的 delta", async () => {
    const emitted: { type: string; delta: string }[] = [];
    await fireNarrations(
      [
        makeToolCall({ toolName: "a", result: null, rejected: true }),
        makeToolCall({ toolName: "b", result: {} /* empty */ }),
      ],
      {
        emit: async (ev) => {
          emitted.push({ type: ev.type as string, delta: (ev.payload as { delta: string }).delta });
        },
        narrateCompatMode: false,
      },
    );
    // 每个工具各一段模板文本（含换行）
    expect(emitted).toHaveLength(2);
    const allDeltas = emitted.map((e) => e.delta).join("");
    expect(allDeltas).toContain("已跳过 a");
    expect(allDeltas).toContain("b 未返回数据");
    // 事件类型都是 text（content 通道）
    expect(emitted.every((e) => e.type === "text")).toBe(true);
  });

  it("无 narrateModel 时模板分支仍生效（零延迟文案）", async () => {
    const emitted: string[] = [];
    await fireNarrations(
      [makeToolCall({ toolName: "x", result: null, error: "boom" })],
      {
        emit: async (ev) => {
          emitted.push((ev.payload as { delta: string }).delta);
        },
        narrateCompatMode: false,
      },
    );
    expect(emitted).toEqual([`${DEFAULT_TEMPLATES.error("x", "boom")}\n`]);
  });

  it("自定义 templates 透传到 streamNarrateToolCall", async () => {
    const emitted: string[] = [];
    await fireNarrations(
      [makeToolCall({ toolName: "y", result: null, rejected: true })],
      {
        emit: async (ev) => {
          emitted.push((ev.payload as { delta: string }).delta);
        },
        narrateCompatMode: false,
        templates: { rejected: (n) => `SKIP ${n}` },
      },
    );
    expect(emitted).toEqual(["SKIP y\n"]);
  });

  it("空 toolCalls 数组 → emit 不调用", async () => {
    let called = false;
    await fireNarrations([], {
      emit: async () => { called = true; },
      narrateCompatMode: false,
    });
    expect(called).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R9：NarrationSequencer（sequence 选项）
// ─────────────────────────────────────────────────────────────────────────────

describe("fireNarrations sequence 模式", () => {
  it("serial（默认）→ 解读按 toolCalls 顺序串行下发", async () => {
    const order: string[] = [];
    // 用模板分支（无 LLM 调用），通过追踪 emit 顺序验证串行
    await fireNarrations(
      [
        makeToolCall({ id: "1", toolName: "first", result: null, rejected: true }),
        makeToolCall({ id: "2", toolName: "second", result: {} /* empty */ }),
        makeToolCall({ id: "3", toolName: "third", result: null, error: "e" }),
      ],
      {
        emit: async (ev) => {
          order.push((ev.payload as { delta: string }).delta);
        },
        narrateCompatMode: false,
        sequence: "serial",
      },
    );
    // 串行：三段按序，每段完整（含换行）后才下一段
    expect(order).toHaveLength(3);
    expect(order[0]).toContain("first");
    expect(order[1]).toContain("second");
    expect(order[2]).toContain("third");
  });

  it("serial 缺省（不传 sequence）→ 也是串行", async () => {
    const order: string[] = [];
    await fireNarrations(
      [
        makeToolCall({ id: "1", toolName: "a", result: null, rejected: true }),
        makeToolCall({ id: "2", toolName: "b", result: {} }),
      ],
      {
        emit: async (ev) => { order.push((ev.payload as { delta: string }).delta); },
        narrateCompatMode: false,
        // 不传 sequence
      },
    );
    expect(order).toHaveLength(2);
    expect(order[0]).toContain("a");
    expect(order[1]).toContain("b");
  });

  it("concurrent → 多解读并发（结果仍完整，顺序可能交错但都在）", async () => {
    const allDeltas: string[] = [];
    await fireNarrations(
      [
        makeToolCall({ id: "1", toolName: "a", result: null, rejected: true }),
        makeToolCall({ id: "2", toolName: "b", result: {} }),
      ],
      {
        emit: async (ev) => { allDeltas.push((ev.payload as { delta: string }).delta); },
        narrateCompatMode: false,
        sequence: "concurrent",
      },
    );
    // 模板分支下并发结果也是 2 段（顺序不保证，但都在）
    expect(allDeltas).toHaveLength(2);
    const joined = allDeltas.join("");
    expect(joined).toContain("a");
    expect(joined).toContain("b");
  });

  it("serial 单工具 → 与并发行为一致", async () => {
    const order: string[] = [];
    await fireNarrations(
      [makeToolCall({ toolName: "solo", result: null, rejected: true })],
      {
        emit: async (ev) => { order.push((ev.payload as { delta: string }).delta); },
        narrateCompatMode: false,
        sequence: "serial",
      },
    );
    expect(order).toEqual([`${DEFAULT_TEMPLATES.rejected("solo")}\n`]);
  });
});
