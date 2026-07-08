/**
 * TraceCompressor 单测（R5 平台基础设施）。
 *
 * 验证 DefaultTraceCompressor 与现有 review-pass.ts 的 compressTrace 输出**字节级一致**
 * （核心回归保障：平台层 move 而非 rewrite）。
 */
import { describe, it, expect } from "vitest";
import { DefaultTraceCompressor, compressTrace } from "../../../src/agent/trace-compressor.js";
import { compressTrace as legacyCompressTrace } from "../../../src/agent/review-pass.js";
import type { StepTrace } from "../../../src/agent/types.js";

const compressor = new DefaultTraceCompressor();

function makeTrace(thought?: string, toolName?: string, result?: unknown): StepTrace[] {
  if (!toolName) {
    return [{ stepNumber: 0, thought, toolCalls: [], finishReason: "stop", usage: { totalTokens: 10 }, durationMs: 0 }];
  }
  return [
    {
      stepNumber: 0,
      thought,
      toolCalls: [{ id: "tc1", toolName, args: {}, result, durationMs: 0 }],
      finishReason: "tool-calls",
      usage: { totalTokens: 10 },
      durationMs: 0,
    },
  ];
}

const EVIDENCE_RESULT = {
  data: { oee: 0.65 },
  freshness: "realtime",
  capturedAt: "2026-06-20T00:00:00Z",
  confidence: "measured",
  source: { system: "MES", provenance: "/oee" },
};

describe("DefaultTraceCompressor.compress", () => {
  it("空轨迹 → 空字符串", () => {
    const r = compressor.compress([], "");
    expect(r.traceDigest).toBe("");
  });

  it("含 thought → 输出 Thought", () => {
    const r = compressor.compress(makeTrace("分析 OEE"), "");
    expect(r.traceDigest).toContain("Thought: 分析 OEE");
    expect(r.traceDigest).toContain("[Step 0]");
  });

  it("含工具调用 → 输出 Action + 工具名", () => {
    const r = compressor.compress(makeTrace("查 OEE", "oee.realtime", {}), "");
    expect(r.traceDigest).toContain("Action: oee.realtime");
  });

  it("工具结果是 EvidenceEnvelope → 附证据徽章", () => {
    const r = compressor.compress(makeTrace("查 OEE", "oee.realtime", EVIDENCE_RESULT), "");
    expect(r.traceDigest).toContain("MES");
    expect(r.traceDigest).toContain("realtime");
    expect(r.traceDigest).toContain("conf=measured");
  });

  it("rejected 工具 → 标记已拒绝", () => {
    const trace: StepTrace[] = [
      {
        stepNumber: 0,
        toolCalls: [{ id: "tc1", toolName: "x.stop", args: {}, result: {}, rejected: true, durationMs: 0 }],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    expect(compressor.compress(trace, "").traceDigest).toContain("已拒绝");
  });

  it("超长 thought → 截断到 200 字 + 省略号", () => {
    const long = "A".repeat(300);
    const r = compressor.compress(makeTrace(long), "");
    expect(r.traceDigest).toContain("…");
    expect(r.traceDigest.length).toBeLessThan(long.length + 50);
  });

  it("多步 → 多行（按步分隔）", () => {
    const trace: StepTrace[] = [
      { stepNumber: 0, thought: "第一步", toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 },
      { stepNumber: 1, thought: "第二步", toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 },
    ];
    const r = compressor.compress(trace, "");
    expect(r.traceDigest).toContain("[Step 0]");
    expect(r.traceDigest).toContain("[Step 1]");
    expect(r.traceDigest.split("\n")).toHaveLength(2);
  });
});

describe("TraceDigest 字段填充", () => {
  it("finalText 透传到 digest", () => {
    const r = compressor.compress([], "最终结论");
    expect(r.finalText).toBe("最终结论");
  });

  it("intent 透传到 digest（可选）", () => {
    const r = compressor.compress(makeTrace("分析"), "结论", { intent: "用户意图" });
    expect(r.intent).toBe("用户意图");
  });

  it("缺省 intent → undefined", () => {
    const r = compressor.compress(makeTrace("分析"), "结论");
    expect(r.intent).toBeUndefined();
  });
});

describe("与 review-pass.ts compressTrace 的字节级一致性（回归保障）", () => {
  // 用同一组输入跑两份实现，确保平台层 move 后行为完全等价
  const cases: Array<{ name: string; trace: StepTrace[] }> = [
    { name: "空轨迹", trace: [] },
    { name: "仅 thought", trace: makeTrace("分析 OEE") },
    { name: "工具调用无证据", trace: makeTrace("查 OEE", "oee.realtime", {}) },
    { name: "工具调用有证据", trace: makeTrace("查 OEE", "oee.realtime", EVIDENCE_RESULT) },
    {
      name: "rejected 工具",
      trace: [
        {
          stepNumber: 0,
          toolCalls: [{ id: "tc1", toolName: "x.stop", args: {}, result: {}, rejected: true, durationMs: 0 }],
          finishReason: "tool-calls",
          usage: {},
          durationMs: 0,
        },
      ],
    },
    { name: "超长 thought", trace: makeTrace("A".repeat(300)) },
    {
      name: "多步混合",
      trace: [
        { stepNumber: 0, thought: "第一步思考", toolCalls: [{ id: "t1", toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT, durationMs: 0 }], finishReason: "tool-calls", usage: {}, durationMs: 0 },
        { stepNumber: 1, thought: "第二步", toolCalls: [], finishReason: "stop", usage: {}, durationMs: 0 },
      ],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const legacy = legacyCompressTrace(c.trace);
      const modern = compressTrace(c.trace);
      expect(modern).toBe(legacy);
    });
  }
});
