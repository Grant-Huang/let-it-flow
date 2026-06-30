/**
 * prepare-step 证据评估集成测试（方案 B 集成层）。
 *
 * 验证 buildNexusPrepareStep 注入评估模型后，收尾意图触发评估的分级处理：
 *   - block：activeTools 移除 nexus_finalize + system 含"禁止收尾"
 *   - soft_warn：保留 nexus_finalize + system 含提醒
 *   - pass：不干预（不调评估或评估放行）
 *   - 无收尾意图：不调评估
 *
 * mock 策略：vi.mock evidence-gate.js，让 evaluateEvidenceGate 返回可控 verdict。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModel } from "ai";

// mock evidence-gate 模块，断言其被调用且返回可控 verdict
vi.mock("../../../../src/agent/evidence-gate.js", () => ({
  evaluateEvidenceGate: vi.fn(),
}));

import { evaluateEvidenceGate } from "../../../../src/agent/evidence-gate.js";
import { buildNexusPrepareStep } from "../../../../apps/nexusops/server/prepare-step.js";
import type { PrepareStepContext, StepTrace } from "../../../../src/agent/types.js";

const dummyModel = { specificationVersion: "v1" } as unknown as LanguageModel;
const mockEvaluate = evaluateEvidenceGate as ReturnType<typeof vi.fn>;

const ALL_TOOLS = [
  "oee.realtime",
  "oee.history",
  "core.web_search",
  "core.knowledge_base",
  "nexus_finalize",
  "nexus_advise",
  "skill.oee_diagnose",
];

beforeEach(() => {
  mockEvaluate.mockReset();
});

/** 构造调了 nexus_finalize 的步骤（收尾意图）。 */
function finalizeStep(): StepTrace {
  return {
    stepNumber: 0,
    thought: "证据够了，收尾",
    toolCalls: [
      // 前面有取证步骤，确保 hasEvidence=true
      { id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 },
      { id: "tc2", toolName: "nexus_finalize", args: {}, result: {}, durationMs: 0 },
    ],
    finishReason: "tool-calls",
    usage: { totalTokens: 10 },
    durationMs: 0,
  };
}

/** 构造无收尾意图的步骤（继续取证）。 */
function investigatingStep(): StepTrace {
  return {
    stepNumber: 0,
    thought: "继续查",
    toolCalls: [{ id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }],
    finishReason: "tool-calls",
    usage: { totalTokens: 10 },
    durationMs: 0,
  };
}

function ctx(steps: StepTrace[]): PrepareStepContext {
  return { steps, stepNumber: steps.length, intent: "OEE 为什么低" };
}

describe("prepare-step + 证据评估 block 分级", () => {
  it("收尾意图 + 评估 block → activeTools 移除 nexus_finalize，system 含禁止收尾", async () => {
    mockEvaluate.mockResolvedValue({
      action: "block",
      confidence: 0.2,
      evidenceGaps: ["未取 availability 拆解", "未交叉验证 performance"],
      overClaims: ["OEE 低归因设备老化"],
    });
    const prepareStep = buildNexusPrepareStep(ALL_TOOLS, dummyModel, false);
    const r = await prepareStep(ctx([finalizeStep()]));
    expect(r).toBeDefined();
    expect(r!.activeTools).toBeDefined();
    // 核心断言：硬阻断后 nexus_finalize 被移除
    expect(r!.activeTools!).not.toContain("nexus_finalize");
    // 其他工具保留（不是全裁）
    expect(r!.activeTools!).toContain("oee.realtime");
    expect(r!.activeTools!).toContain("nexus_advise");
    // system 含阻断说明 + 证据缺口
    expect(r!.system).toContain("禁止收尾");
    expect(r!.system).toContain("未取 availability");
  });
});

describe("prepare-step + 证据评估 soft_warn 分级", () => {
  it("收尾意图 + 评估 soft_warn → 保留 nexus_finalize，system 含提醒", async () => {
    mockEvaluate.mockResolvedValue({
      action: "soft_warn",
      confidence: 0.5,
      evidenceGaps: ["availability 数据偏旧"],
      overClaims: [],
    });
    const prepareStep = buildNexusPrepareStep(ALL_TOOLS, dummyModel, false);
    const r = await prepareStep(ctx([finalizeStep()]));
    expect(r).toBeDefined();
    // 软提示保留 finalize（与 block 的硬移除对比）
    expect(r!.activeTools).toContain("nexus_finalize");
    expect(r!.system).toContain("证据充分性提醒");
    expect(r!.system).toContain("availability 数据偏旧");
  });
});

describe("prepare-step + 证据评估 pass / 未触发", () => {
  it("收尾意图 + 评估 pass → 不干预（evaluate 返回 pass 但被 tryEvaluate 过滤）", async () => {
    mockEvaluate.mockResolvedValue({
      action: "pass",
      confidence: 0.9,
      evidenceGaps: [],
      overClaims: [],
    });
    const prepareStep = buildNexusPrepareStep(ALL_TOOLS, dummyModel, false);
    const r = await prepareStep(ctx([finalizeStep()]));
    // 评估被调了
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    // pass 不干预：finalizeStep 含 oee.realtime（主导域 oee），所以 activeTools 仍产出（裁域），但 system 无评估注入
    if (r?.system) {
      expect(r.system).not.toContain("证据充分性提醒");
      expect(r.system).not.toContain("禁止收尾");
    }
  });

  it("无收尾意图 → 不调评估", async () => {
    const prepareStep = buildNexusPrepareStep(ALL_TOOLS, dummyModel, false);
    await prepareStep(ctx([investigatingStep()]));
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("未注入评估模型 → 不调评估，退化为纯裁域行为", async () => {
    const prepareStep = buildNexusPrepareStep(ALL_TOOLS); // 无 model
    const r = await prepareStep(ctx([finalizeStep()]));
    expect(mockEvaluate).not.toHaveBeenCalled();
    // 纯裁域：nexus_finalize 仍在
    expect(r?.activeTools).toContain("nexus_finalize");
  });
});
