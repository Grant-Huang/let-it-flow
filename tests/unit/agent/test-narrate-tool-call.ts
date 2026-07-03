/**
 * narrateToolCall 单测（混合策略 —— 模板兜底 + LLM 增强）。
 *
 * 覆盖：
 *   - HITL 拒绝 → 模板（不调 LLM）
 *   - 工具抛错 → 模板（不调 LLM）
 *   - governance 阻断 → 模板（不调 LLM）
 *   - 空结果 → 模板（不调 LLM）
 *   - EvidenceEnvelope + narrateModel → 走 LLM 解读
 *   - EvidenceEnvelope 无 narrateModel → 空字符串（保留向后兼容）
 *   - 裸对象 + narrateModel → 走 LLM 兜底解读
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock ai 模块的 generateText，避免真实 LLM 调用
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
import { narrateToolCall } from "../../../src/agent/narrate-pass.js";
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

describe("narrateToolCall 确定性模板分支（不调 LLM）", () => {
  it("HITL 拒绝 → 返回『已跳过』模板，不调 model", async () => {
    const r = await narrateToolCall(
      { toolName: "schedule.update", args: {}, result: { skipped: true, reason: "用户拒绝" }, rejected: true },
      { model: dummyModel },
    );
    expect(r).toContain("已跳过");
    expect(r).toContain("schedule.update");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("工具抛错 → 返回失败模板含 error 信息，不调 model", async () => {
    const r = await narrateToolCall(
      { toolName: "oee.realtime", args: { line: "L01" }, result: null, error: "MES 连接超时" },
      { model: dummyModel },
    );
    expect(r).toContain("执行失败");
    expect(r).toContain("MES 连接超时");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("governance 阻断 → 返回『未执行』模板含 reason，不调 model", async () => {
    const r = await narrateToolCall(
      {
        toolName: "schedule.update",
        args: {},
        result: { skipped: true, reason: "排产窗口外禁止改单", governance_blocked: true },
      },
      { model: dummyModel },
    );
    expect(r).toContain("未执行");
    expect(r).toContain("治理规则阻断");
    expect(r).toContain("排产窗口外禁止改单");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("空对象结果 → 返回『未返回数据』模板，不调 model", async () => {
    const r = await narrateToolCall(
      { toolName: "quality.defect", args: {}, result: {} },
      { model: dummyModel },
    );
    expect(r).toContain("未返回数据");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("null 结果 → 返回『未返回数据』模板，不调 model", async () => {
    const r = await narrateToolCall(
      { toolName: "quality.defect", args: {}, result: null },
      { model: dummyModel },
    );
    expect(r).toContain("未返回数据");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("空数组结果 → 返回『未返回数据』模板", async () => {
    const r = await narrateToolCall(
      { toolName: "list.items", args: {}, result: [] },
      { model: dummyModel },
    );
    expect(r).toContain("未返回数据");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("narrateToolCall LLM 解读分支", () => {
  it("EvidenceEnvelope + narrateModel → 走 LLM 生成解读", async () => {
    mockGenerateText.mockResolvedValue({ text: "查到 L01 实时 OEE=0.62，可用率 0.7 偏低。" });
    const r = await narrateToolCall(
      { toolName: "oee.realtime", args: { line: "L01" }, result: EVIDENCE_RESULT },
      { model: dummyModel },
    );
    expect(r).toBe("查到 L01 实时 OEE=0.62，可用率 0.7 偏低。");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("EvidenceEnvelope 无 narrateModel → 返回空（向后兼容）", async () => {
    const r = await narrateToolCall(
      { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
      {},
    );
    expect(r).toBe("");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("LLM 抛错 → 降级返回空字符串（不抛出）", async () => {
    mockGenerateText.mockRejectedValue(new Error("rate limit"));
    const r = await narrateToolCall(
      { toolName: "oee.realtime", args: {}, result: EVIDENCE_RESULT },
      { model: dummyModel },
    );
    expect(r).toBe("");
  });

  it("裸对象 + narrateModel → 走 LLM 兜底解读", async () => {
    mockGenerateText.mockResolvedValue({ text: "取回了 3 条记录。" });
    const r = await narrateToolCall(
      { toolName: "custom.tool", args: {}, result: { count: 3 } },
      { model: dummyModel },
    );
    expect(r).toBe("取回了 3 条记录。");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("裸对象无 narrateModel → 返回空（不调 LLM）", async () => {
    const r = await narrateToolCall(
      { toolName: "custom.tool", args: {}, result: { count: 3 } },
      {},
    );
    expect(r).toBe("");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("narrateToolCall 优先级", () => {
  it("rejected 优先于 error（用户拒绝不报告错误）", async () => {
    const r = await narrateToolCall(
      { toolName: "t", args: {}, result: {}, rejected: true, error: "should not appear" },
      { model: dummyModel },
    );
    expect(r).toContain("已跳过");
    expect(r).not.toContain("should not appear");
  });

  it("error 优先于 governance 阻断（同时存在时按错误报告）", async () => {
    const r = await narrateToolCall(
      { toolName: "t", args: {}, result: { skipped: true, reason: "阻断理由", governance_blocked: true }, error: "执行出错" },
      { model: dummyModel },
    );
    expect(r).toContain("执行失败");
    expect(r).toContain("执行出错");
  });
});
