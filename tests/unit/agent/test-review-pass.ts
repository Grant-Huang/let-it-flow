/**
 * review-pass 单测（C1 平台机制）。
 *
 * 直接测试纯函数（compressTrace / parseReviewReport），避免脆弱的 SDK model mock。
 * runReviewPass 的真实 LLM 调用由 e2e 覆盖；这里只测空输入降级路径。
 */
import { describe, it, expect } from "vitest";
import {
  runReviewPass,
  compressTrace,
  parseReviewReport,
} from "../../src/agent/review-pass.js";
import type { StepTrace } from "../../src/agent/types.js";
import type { LanguageModel } from "ai";

/** 占位 model（runReviewPass 空输入路径不会真调它）。 */
const dummyModel = { specificationVersion: "v1" } as unknown as LanguageModel;

/** 构造一个最小 StepTrace。 */
function makeTrace(thought?: string, toolName?: string, result?: unknown): StepTrace[] {
  if (!toolName) {
    return [{ stepNumber: 0, thought, toolCalls: [], finishReason: "stop", usage: { totalTokens: 10 }, durationMs: 0 }];
  }
  return [
    {
      stepNumber: 0,
      thought,
      toolCalls: [
        { id: "tc1", toolName, args: {}, result, durationMs: 0 },
      ],
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

describe("compressTrace", () => {
  it("空轨迹 → 空字符串", () => {
    expect(compressTrace([])).toBe("");
  });

  it("含 thought → 输出 Thought", () => {
    const r = compressTrace(makeTrace("分析 OEE"));
    expect(r).toContain("Thought: 分析 OEE");
    expect(r).toContain("[Step 0]");
  });

  it("含工具调用 → 输出 Action + 工具名", () => {
    const r = compressTrace(makeTrace("查 OEE", "oee.realtime", {}));
    expect(r).toContain("Action: oee.realtime");
  });

  it("工具结果是 EvidenceEnvelope → 附证据徽章", () => {
    const r = compressTrace(makeTrace("查 OEE", "oee.realtime", EVIDENCE_RESULT));
    expect(r).toContain("MES");
    expect(r).toContain("realtime");
    expect(r).toContain("conf=measured");
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
    expect(compressTrace(trace)).toContain("已拒绝");
  });

  it("超长 thought → 截断到 200 字 + 省略号", () => {
    const long = "A".repeat(300);
    const r = compressTrace(makeTrace(long));
    expect(r).toContain("…");
    expect(r.length).toBeLessThan(long.length + 50);
  });
});

describe("parseReviewReport", () => {
  it("合法 JSON → 正确解析", () => {
    const text = JSON.stringify({
      overClaims: ["过度声明"],
      unsupportedConclusions: ["无支撑"],
      evidenceGaps: ["缺口"],
      confidence: 0.4,
    });
    const r = parseReviewReport(text);
    expect(r.skipped).toBeUndefined();
    expect(r.overClaims).toEqual(["过度声明"]);
    expect(r.unsupportedConclusions).toEqual(["无支撑"]);
    expect(r.evidenceGaps).toEqual(["缺口"]);
    expect(r.confidence).toBe(0.4);
  });

  it("markdown 代码块包裹 → 仍能解析", () => {
    const text = "```json\n" + JSON.stringify({ overClaims: [], unsupportedConclusions: [], evidenceGaps: [], confidence: 0.9 }) + "\n```";
    const r = parseReviewReport(text);
    expect(r.skipped).toBeUndefined();
    expect(r.confidence).toBe(0.9);
  });

  it("confidence > 1 → clamp 到 1", () => {
    const r = parseReviewReport(JSON.stringify({ confidence: 1.5 }));
    expect(r.confidence).toBe(1);
  });

  it("confidence < 0 → clamp 到 0", () => {
    const r = parseReviewReport(JSON.stringify({ confidence: -0.3 }));
    expect(r.confidence).toBe(0);
  });

  it("confidence 缺省 → 默认 0", () => {
    const r = parseReviewReport(JSON.stringify({ overClaims: ["x"] }));
    expect(r.confidence).toBe(0);
    expect(r.overClaims).toEqual(["x"]);
  });

  it("非 JSON 文本 → skipped", () => {
    const r = parseReviewReport("这不是 JSON");
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain("解析");
  });

  it("空文本 → skipped", () => {
    const r = parseReviewReport("");
    expect(r.skipped).toBe(true);
  });

  it("非数组的 overClaims → 转空数组（容错）", () => {
    const r = parseReviewReport(JSON.stringify({ overClaims: "不是数组", confidence: 0.5 }));
    expect(r.overClaims).toEqual([]);
    expect(r.confidence).toBe(0.5);
  });
});

describe("runReviewPass 空输入降级", () => {
  it("trace 与 finalText 均为空 → skipped（不调 model）", async () => {
    const r = await runReviewPass([], "", { model: dummyModel });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain("空");
  });
});
