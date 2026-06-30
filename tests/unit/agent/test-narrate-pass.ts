/**
 * narrate-pass 单测（O 层工具结果解读）。
 *
 * 测试策略：
 *   - 非 EvidenceEnvelope → 直接返回空字符串（不调 model）
 *   - mock generateText 返回固定文本 → 断言拿到该文本
 *   - mock generateText 抛错 → 降级返回空字符串（不阻断主流程）
 *   - 空输出/过短 → 返回空（让 harness 跳过 emit）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock ai 模块的 generateText，避免真实 LLM 调用
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
import { narrateStepResult } from "../../../src/agent/narrate-pass.js";
import type { LanguageModel } from "ai";

const dummyModel = { specificationVersion: "v1" } as unknown as LanguageModel;

const EVIDENCE_RESULT = {
  data: { oee: 0.62, availability: 0.7, performance: 0.9, quality: 0.98 },
  freshness: "realtime",
  capturedAt: "2026-06-29T14:00:00Z",
  confidence: "measured",
  source: { system: "MES", provenance: "/mes/oee/realtime?line=L01" },
};

const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGenerateText.mockReset();
});

describe("narrateStepResult 输入校验", () => {
  it("非 EvidenceEnvelope（纯对象）→ 返回空字符串，不调 model", async () => {
    const r = await narrateStepResult("oee.realtime", {}, { foo: "bar" }, { model: dummyModel });
    expect(r).toBe("");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("result 为 null → 返回空字符串", async () => {
    const r = await narrateStepResult("oee.realtime", {}, null, { model: dummyModel });
    expect(r).toBe("");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("result 缺关键字段 → 视为非信封，返回空", async () => {
    const partial = { data: { oee: 0.6 }, freshness: "realtime" };
    const r = await narrateStepResult("oee.realtime", {}, partial, { model: dummyModel });
    expect(r).toBe("");
  });
});

describe("narrateStepResult 正常路径", () => {
  it("EvidenceEnvelope + model 返回文本 → 返回该文本（trim 后）", async () => {
    mockGenerateText.mockResolvedValue({ text: "查到 L01 实时 OEE=0.62，可用率 0.7 偏低拖累效率。" });
    const r = await narrateStepResult("oee.realtime", { line: "L01" }, EVIDENCE_RESULT, {
      model: dummyModel,
    });
    expect(r).toBe("查到 L01 实时 OEE=0.62，可用率 0.7 偏低拖累效率。");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("model 返回带空白 → trim 后返回", async () => {
    mockGenerateText.mockResolvedValue({ text: "  发现质量率 0.98 正常。  " });
    const r = await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, { model: dummyModel });
    expect(r).toBe("发现质量率 0.98 正常。");
  });

  it("compatMode=true → system 折叠进 user 消息", async () => {
    mockGenerateText.mockResolvedValue({ text: "测试解读。" });
    await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, {
      model: dummyModel,
      compatMode: true,
    });
    const callArgs = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
    // compatMode 时不应有顶层 system，而是合并进 messages[0].content
    expect(callArgs.system).toBeUndefined();
    const messages = callArgs.messages as Array<{ content: string }>;
    expect(messages[0]!.content).toContain("解说员");
    expect(messages[0]!.content).toContain("---");
  });

  it("compatMode=false → system 独立字段", async () => {
    mockGenerateText.mockResolvedValue({ text: "测试解读。" });
    await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, {
      model: dummyModel,
      compatMode: false,
    });
    const callArgs = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.system).toContain("解说员");
  });
});

describe("narrateStepResult 降级路径", () => {
  it("model 抛错 → 返回空字符串（不抛出）", async () => {
    mockGenerateText.mockRejectedValue(new Error("API timeout"));
    const r = await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, { model: dummyModel });
    expect(r).toBe("");
  });

  it("model 返回空字符串 → 返回空", async () => {
    mockGenerateText.mockResolvedValue({ text: "" });
    const r = await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, { model: dummyModel });
    expect(r).toBe("");
  });

  it("model 返回过短（<4 字）→ 视为无效，返回空", async () => {
    mockGenerateText.mockResolvedValue({ text: "ab" });
    const r = await narrateStepResult("oee.realtime", {}, EVIDENCE_RESULT, { model: dummyModel });
    expect(r).toBe("");
  });
});
