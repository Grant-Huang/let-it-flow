/**
 * stop-policy 条件行为验证（深度补充）。
 *
 * test-agent-harness.ts 已覆盖 buildStopWhen 的"条件数量 + 缺省常量"，
 * 但只验证数量，没验证条件函数本身的行为。本文件补齐：
 *   - costCap 条件：累计 token 达上限时返回 true，未达时返回 false
 *   - extra 条件：被正确合并且可触发
 *   - 多条件组合：任一满足即停（OR 语义）
 *
 * buildStopWhen 返回的条件签名是 (opts: { steps }) => boolean，
 * 直接构造 steps 数组调用即可验证行为。
 */
import { describe, it, expect } from "vitest";
import { buildStopWhen, DEFAULT_MAX_STEPS, DEFAULT_FINALIZE_TOOL } from "../../../src/agent/stop-policy.js";

/** 构造模拟 SDK step 数组（带 usage）。 */
function makeSteps(usageList: Array<{ inputTokens?: number; outputTokens?: number }>) {
  return usageList.map((u) => ({
    usage: {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
    },
  }));
}

describe("stop-policy 条件行为（深度）", () => {
  it("costCap.maxInputTokens：累计达上限 → 触发停止", () => {
    const conditions = buildStopWhen({ costCap: { maxInputTokens: 1000 } });
    // conditions[2] 是 costCap 条件（0=stepCount, 1=finalize, 2=costCap）
    const costCapCondition = conditions[2]!;
    const at = costCapCondition({ steps: makeSteps([{ inputTokens: 600 }, { inputTokens: 500 }]) });
    const below = costCapCondition({ steps: makeSteps([{ inputTokens: 300 }, { inputTokens: 400 }]) });
    expect(at, "累计 1100 >= 1000 应停止").toBe(true);
    expect(below, "累计 700 < 1000 不应停止").toBe(false);
  });

  it("costCap.maxOutputTokens：累计输出达上限 → 触发", () => {
    const conditions = buildStopWhen({ costCap: { maxOutputTokens: 500 } });
    const costCapCondition = conditions[2]!;
    const at = costCapCondition({ steps: makeSteps([{ outputTokens: 300 }, { outputTokens: 250 }]) });
    const below = costCapCondition({ steps: makeSteps([{ outputTokens: 100 }, { outputTokens: 200 }]) });
    expect(at, "累计输出 550 >= 500 应停止").toBe(true);
    expect(below, "累计输出 300 < 500 不应停止").toBe(false);
  });

  it("costCap 缺省值：usage.inputTokens 缺失时按 0 处理（不误触）", () => {
    const conditions = buildStopWhen({ costCap: { maxInputTokens: 100 } });
    const costCapCondition = conditions[2]!;
    // 缺 inputTokens 字段 → 视为 0，累计 0 < 100 不应停止
    const r = costCapCondition({
      steps: [{ usage: {} }, { usage: { outputTokens: 50 } }],
    });
    expect(r, "缺 inputTokens 视为 0，累计 0 < 100 不停止").toBe(false);
  });

  it("extra 条件：自定义条件被合并且可独立触发", () => {
    let extraCalled = false;
    const extra = [() => {
      extraCalled = true;
      return true;
    }];
    const conditions = buildStopWhen(undefined, extra);
    expect(conditions.length, "缺省2 + extra1 = 3").toBe(3);
    const r = conditions[2]!({ steps: [] });
    expect(extraCalled, "extra 条件被调用").toBe(true);
    expect(r, "extra 返回 true 时停止").toBe(true);
  });

  it("组合 OR 语义：任一条件满足即停止", () => {
    // 用一个总是返回 true 的 extra 模拟"任一满足即停"
    const conditions = buildStopWhen(undefined, [() => true]);
    const stop = conditions.some((c) => c({ steps: [] }));
    expect(stop, "至少一个条件返回 true → 停止").toBe(true);

    // 全 false 时不停止
    const conditions2 = buildStopWhen(undefined, [() => false]);
    // stepCount(15)/finalize 默认条件下空 steps 不触发（stepCount 需达 15，finalize 需有 tool call）
    const allFalse = conditions2.every((c) => c({ steps: [] }) === false);
    expect(allFalse, "全条件 false（空 steps）→ 不停止").toBe(true);
  });

  it("缺省值稳定：maxSteps=15, finalizeTool=nexus_finalize", () => {
    expect(DEFAULT_MAX_STEPS).toBe(15);
    expect(DEFAULT_FINALIZE_TOOL).toBe("nexus_finalize");
  });
});
