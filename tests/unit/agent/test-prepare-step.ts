/**
 * prepare-step 单测（A3）。
 *
 * 验证 buildNexusPrepareStep 的两个职责：
 *   1. 动态裁工具：识别主导域后只保留该域 + core 通用 + nexus 收尾 + skill
 *   2. every_step precondition 提示注入：取证不足时注入 system 提醒
 */
import { describe, it, expect } from "vitest";
import { buildNexusPrepareStep } from "../../apps/nexusops/server/prepare-step.js";
import type { PrepareStepContext, StepTrace } from "../../src/agent/types.js";

/** 全部工具名（模拟 harness 暴露给 LLM 的工具集）。 */
const ALL_TOOLS = [
  "core.web_search",
  "core.web_fetch",
  "core.knowledge_base",
  "oee.realtime",
  "oee.history",
  "equipment.downtime",
  "equipment.health",
  "quality.pareto",
  "quality.defects",
  "process.parameters",
  "energy.realtime",
  "schedule.current",
  "material.wip_level",
  "skill.oee_diagnose",
  "skill.downtime_root_cause",
  "nexus_finalize",
  "nexus_advise",
];

const prepareStep = buildNexusPrepareStep(ALL_TOOLS);

/** 构造一个只含 toolCalls 的简化 step（测试用）。 */
function step(toolNames: string[], thought?: string): StepTrace {
  return {
    stepNumber: 0,
    thought,
    toolCalls: toolNames.map((name, i) => ({
      id: `tc${i}`,
      toolName: name,
      args: {},
      result: {},
      durationMs: 0,
    })),
    finishReason: "tool-calls",
    usage: { totalTokens: 10 },
    durationMs: 0,
  };
}

function ctx(steps: StepTrace[]): PrepareStepContext {
  return { steps, stepNumber: steps.length, intent: "测试" };
}

describe("prepare-step 动态裁工具", () => {
  it("无 domain 调用 → 不裁（返回全部工具，undefined activeTools）", () => {
    const r = prepareStep(ctx([step(["core.web_search"])]));
    // 无主导域 + 无提醒 → 返回 undefined
    expect(r).toBeUndefined();
  });

  it("主导 OEE 域 → 只保留 oee + core 通用 + nexus 收尾 + skill", () => {
    const r = prepareStep(ctx([step(["oee.realtime", "oee.history", "oee.decompose"])]));
    expect(r).toBeDefined();
    expect(r!.activeTools).toBeDefined();
    const active = new Set(r!.activeTools!);
    // oee 域保留
    expect(active.has("oee.realtime")).toBe(true);
    expect(active.has("oee.history")).toBe(true);
    // core 通用保留
    expect(active.has("core.web_search")).toBe(true);
    expect(active.has("core.knowledge_base")).toBe(true);
    // nexus 收尾保留
    expect(active.has("nexus_finalize")).toBe(true);
    expect(active.has("nexus_advise")).toBe(true);
    // skill 保留
    expect(active.has("skill.oee_diagnose")).toBe(true);
    // 其他域裁掉
    expect(active.has("equipment.downtime")).toBe(false);
    expect(active.has("quality.pareto")).toBe(false);
    expect(active.has("energy.realtime")).toBe(false);
    expect(active.has("schedule.current")).toBe(false);
    expect(active.has("material.wip_level")).toBe(false);
  });

  it("主导 equipment 域 → 裁掉 oee/quality 等", () => {
    const r = prepareStep(ctx([step(["equipment.downtime", "equipment.health"])]));
    const active = new Set(r!.activeTools!);
    expect(active.has("equipment.downtime")).toBe(true);
    expect(active.has("oee.realtime")).toBe(false);
  });

  it("单次偶发 domain 调用未达主导阈值 → 不裁（避免误裁）", () => {
    // 1 次 oee + 1 次 equipment，无主导（各占 50%，未超 0.5 阈值）
    const r = prepareStep(ctx([step(["oee.realtime", "equipment.downtime"])]));
    expect(r?.activeTools).toBeUndefined();
  });
});

describe("prepare-step every_step 提示注入", () => {
  it("讨论 OEE 但未取证就调 advise → 注入提醒", () => {
    const r = prepareStep(
      ctx([step(["nexus_advise"], "用户问 OEE 为什么低，我直接给建议")]),
    );
    expect(r).toBeDefined();
    expect(r!.system).toBeDefined();
    expect(r!.system!).toContain("oee");
    expect(r!.system!).toContain("取证");
  });

  it("讨论停机但未取证就调 advise → 注入提醒", () => {
    const r = prepareStep(
      ctx([step(["nexus_advise"], "停机原因是设备老化")]),
    );
    expect(r!.system).toBeDefined();
    expect(r!.system!).toContain("停机");
  });

  it("已取证 → 无提醒（system 为 undefined）", () => {
    const r = prepareStep(
      ctx([step(["oee.realtime", "nexus_advise"], "已查 OEE 实测，给建议")]),
    );
    // 已取证，无提醒；但 oee 是主导域，所以 activeTools 会产出
    expect(r?.system).toBeUndefined();
    expect(r?.activeTools).toBeDefined();
  });

  it("不涉及 OEE/停机 → 无提醒", () => {
    const r = prepareStep(
      ctx([step(["energy.realtime", "nexus_advise"], "能耗偏高，建议优化")]),
    );
    expect(r?.system).toBeUndefined();
  });
});
