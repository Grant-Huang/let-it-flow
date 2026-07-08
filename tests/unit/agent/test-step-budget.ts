/**
 * StepBudget 单测（R4 平台基础设施）。
 *
 * 验证步数预算计算的边界、phase 切换阈值（与 NexusOps 现有硬编码 0.4/0.8 一致）。
 */
import { describe, it, expect } from "vitest";
import { computeStepBudget } from "../../../src/agent/step-budget.js";

describe("computeStepBudget", () => {
  describe("基础字段", () => {
    it("正确填充 total/used/remaining/ratio", () => {
      const b = computeStepBudget(3, 10);
      expect(b.total).toBe(10);
      expect(b.used).toBe(3);
      expect(b.remaining).toBe(8); // 10 - 3 + 1 = 8（含当前步）
      expect(b.ratio).toBeCloseTo(0.3, 5);
    });

    it("remaining 包含当前步（至少 1）", () => {
      expect(computeStepBudget(5, 10).remaining).toBe(6);
      expect(computeStepBudget(10, 10).remaining).toBe(1);
    });

    it("stepNumber=0 也合法（ramp_up 起点）", () => {
      const b = computeStepBudget(0, 10);
      expect(b.used).toBe(0);
      expect(b.ratio).toBe(0);
      expect(b.phase).toBe("ramp_up");
    });
  });

  describe("phase 切换阈值", () => {
    it("ratio < 0.4 → ramp_up", () => {
      expect(computeStepBudget(1, 10).phase).toBe("ramp_up"); // 0.1
      expect(computeStepBudget(3, 10).phase).toBe("ramp_up"); // 0.3
    });

    it("ratio == 0.4 → focus（左闭）", () => {
      // 4/10 = 0.4，触发 focus
      expect(computeStepBudget(4, 10).phase).toBe("focus");
    });

    it("0.4 ≤ ratio < 0.8 → focus", () => {
      expect(computeStepBudget(5, 10).phase).toBe("focus"); // 0.5
      expect(computeStepBudget(7, 10).phase).toBe("focus"); // 0.7
    });

    it("ratio >= 0.8 → wrap_up", () => {
      // 8/10 = 0.8 触发 wrap_up（与 NexusOps prepare-step.ts:182 的 Math.ceil(10*0.8)=8 一致）
      expect(computeStepBudget(8, 10).phase).toBe("wrap_up");
      expect(computeStepBudget(9, 10).phase).toBe("wrap_up");
      expect(computeStepBudget(10, 10).phase).toBe("wrap_up");
    });
  });

  describe("边界：maxSteps=1（极端短任务）", () => {
    it("唯一一步就是 wrap_up", () => {
      const b = computeStepBudget(1, 1);
      expect(b.ratio).toBe(1);
      expect(b.phase).toBe("wrap_up");
      expect(b.remaining).toBe(1);
    });
  });

  describe("边界：stepNumber 超过 maxSteps（容错）", () => {
    it("ratio > 1 时仍 wrap_up，remaining 不为负", () => {
      const b = computeStepBudget(15, 10);
      expect(b.ratio).toBe(1.5);
      expect(b.phase).toBe("wrap_up");
      expect(b.remaining).toBeGreaterThanOrEqual(1);
    });
  });

  describe("阈值与 NexusOps 现有实现的一致性", () => {
    // 这组测试是回归保障：确保 computeStepBudget 的 phase 与 NexusOps 现有逻辑等价。
    // NexusOps prepare-step.ts:182 用 Math.ceil(maxSteps * 0.8) 触发 80% 预警，
    // preconditions.ts:285-293 用 ratio < 0.4 / < 0.8 / else 三档分级。
    it("maxSteps=12（NexusOps 默认）的 phase 切换点", () => {
      // 40% = 4.8 → 第 5 步进入 focus
      expect(computeStepBudget(4, 12).phase).toBe("ramp_up"); // 0.33
      expect(computeStepBudget(5, 12).phase).toBe("focus"); // 0.42
      // 80% = 9.6 → 第 10 步进入 wrap_up（ceil(12*0.8)=10）
      expect(computeStepBudget(9, 12).phase).toBe("focus"); // 0.75
      expect(computeStepBudget(10, 12).phase).toBe("wrap_up"); // 0.83
    });
  });
});
