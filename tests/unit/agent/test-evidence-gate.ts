/**
 * evidence-gate 单测（V 层收尾前证据评估）。
 *
 * 测试策略：
 *   - resolveAction 阈值边界：≥0.7 pass / 0.4-0.7 soft_warn / <0.4 block
 *   - evaluateEvidenceGate：mock generateText 返回不同 confidence，断言 action 分级
 *   - 失败降级：model 抛错/解析失败 → skipped:true, action:"pass" 不阻断
 *   - 空轨迹 → 跳过评估
 *   - compatMode system 折叠进 user
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock ai 模块的 generateText，避免真实 LLM 调用
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
import { evaluateEvidenceGate, resolveAction } from "../../../src/agent/evidence-gate.js";
import type { LanguageModel } from "ai";
import type { StepTrace } from "../../../src/agent/types.js";

const dummyModel = { specificationVersion: "v1" } as unknown as LanguageModel;
const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGenerateText.mockReset();
});

/** 构造含工具调用的轨迹（确保 compressTrace 非空）。 */
function makeTrace(toolName = "oee.realtime"): StepTrace[] {
  return [
    {
      stepNumber: 0,
      thought: "查 OEE",
      toolCalls: [
        { id: "tc1", toolName, args: {}, result: {}, durationMs: 0 },
      ],
      finishReason: "tool-calls",
      usage: { totalTokens: 10 },
      durationMs: 0,
    } as unknown as StepTrace,
  ];
}

describe("resolveAction 阈值分级", () => {
  it("confidence ≥ 0.7 → pass", () => {
    expect(resolveAction(0.7)).toBe("pass");
    expect(resolveAction(0.95)).toBe("pass");
    expect(resolveAction(1)).toBe("pass");
  });

  it("0.4 ≤ confidence < 0.7 → soft_warn", () => {
    expect(resolveAction(0.4)).toBe("soft_warn");
    expect(resolveAction(0.5)).toBe("soft_warn");
    expect(resolveAction(0.69)).toBe("soft_warn");
  });

  it("confidence < 0.4 → block", () => {
    expect(resolveAction(0.39)).toBe("block");
    expect(resolveAction(0.1)).toBe("block");
    expect(resolveAction(0)).toBe("block");
  });
});

describe("evaluateEvidenceGate 分级评估", () => {
  it("confidence=0.8 → action:pass，不阻断", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"overClaims":[],"unsupportedConclusions":[],"evidenceGaps":[],"confidence":0.8}',
    });
    const r = await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", { model: dummyModel });
    expect(r.action).toBe("pass");
    expect(r.confidence).toBe(0.8);
    expect(r.skipped).toBeUndefined();
  });

  it("confidence=0.5 → action:soft_warn，带 evidenceGaps", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"overClaims":[],"unsupportedConclusions":[],"evidenceGaps":["缺 availability 拆解"],"confidence":0.5}',
    });
    const r = await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", { model: dummyModel });
    expect(r.action).toBe("soft_warn");
    expect(r.confidence).toBe(0.5);
    expect(r.evidenceGaps).toEqual(["缺 availability 拆解"]);
  });

  it("confidence=0.2 → action:block，带 evidenceGaps 和 overClaims", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"overClaims":["OEE 低是设备老化"],"unsupportedConclusions":[],"evidenceGaps":["未取 availability","未取 performance"],"confidence":0.2}',
    });
    const r = await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", { model: dummyModel });
    expect(r.action).toBe("block");
    expect(r.confidence).toBe(0.2);
    expect(r.evidenceGaps).toHaveLength(2);
    expect(r.overClaims).toEqual(["OEE 低是设备老化"]);
  });
});

describe("evaluateEvidenceGate 降级路径", () => {
  it("model 抛错 → skipped:true, action:pass 不阻断", async () => {
    mockGenerateText.mockRejectedValue(new Error("API timeout"));
    const r = await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", { model: dummyModel });
    expect(r.skipped).toBe(true);
    expect(r.action).toBe("pass");
  });

  it("model 返回非 JSON → 解析失败 → skipped:true, action:pass", async () => {
    mockGenerateText.mockResolvedValue({ text: "这不是合法 JSON" });
    const r = await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", { model: dummyModel });
    expect(r.skipped).toBe(true);
    expect(r.action).toBe("pass");
  });

  it("空轨迹 → skipped:true, action:pass（不调 model）", async () => {
    const r = await evaluateEvidenceGate([], "OEE 为什么低", { model: dummyModel });
    expect(r.skipped).toBe(true);
    expect(r.action).toBe("pass");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("evaluateEvidenceGate 兼容模式", () => {
  it("compatMode=true → system 折叠进 user 消息", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"overClaims":[],"unsupportedConclusions":[],"evidenceGaps":[],"confidence":0.8}',
    });
    await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", {
      model: dummyModel,
      compatMode: true,
    });
    const callArgs = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.system).toBeUndefined();
    const messages = callArgs.messages as Array<{ content: string }>;
    expect(messages[0]!.content).toContain("证据评估员");
    expect(messages[0]!.content).toContain("用户意图");
  });

  it("compatMode=false → system 独立字段", async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"overClaims":[],"unsupportedConclusions":[],"evidenceGaps":[],"confidence":0.8}',
    });
    await evaluateEvidenceGate(makeTrace(), "OEE 为什么低", {
      model: dummyModel,
      compatMode: false,
    });
    const callArgs = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.system).toContain("证据评估员");
  });
});
