/**
 * prepareStep 中间件模式单测（R6 钩子与摘要）。
 *
 * 验证：
 *   - composePrepareStep 的洋葱模型顺序（外层先进入、后返回）
 *   - next() 短路（中间件可以不调 next 提前返回）
 *   - stepBudgetWarnMiddleware 在 wrap_up 阶段注入预警
 *   - 组合多个中间件的语义
 */
import { describe, it, expect } from "vitest";
import {
  composePrepareStep,
  stepBudgetWarnMiddleware,
  type PrepareStepMiddleware,
} from "../../../src/agent/prepare-step-middleware.js";
import type { PrepareStepContext, PrepareStepResult } from "../../../src/agent/types.js";
import type { StepBudget } from "../../../src/agent/step-budget.js";

function ctx(opts: { stepNumber?: number; budget?: StepBudget; intent?: string }): PrepareStepContext {
  return {
    steps: [],
    stepNumber: opts.stepNumber ?? 1,
    intent: opts.intent ?? "测试",
    budget: opts.budget,
  };
}

const rampUpBudget: StepBudget = { total: 10, used: 1, remaining: 10, ratio: 0.1, phase: "ramp_up" };
const focusBudget: StepBudget = { total: 10, used: 5, remaining: 6, ratio: 0.5, phase: "focus" };
const wrapUpBudget: StepBudget = { total: 10, used: 9, remaining: 2, ratio: 0.9, phase: "wrap_up" };

describe("composePrepareStep 洋葱模型", () => {
  it("空中间件列表 → 始终返回 undefined", async () => {
    const fn = composePrepareStep([]);
    expect(await fn(ctx({}))).toBeUndefined();
  });

  it("单个中间件无 next → 返回其结果", async () => {
    const mw: PrepareStepMiddleware = async () => ({ system: "only-mw" });
    const fn = composePrepareStep([mw]);
    const r = await fn(ctx({}));
    expect(r?.system).toBe("only-mw");
  });

  it("外层中间件先执行，能改写最终结果", async () => {
    const order: string[] = [];
    const outer: PrepareStepMiddleware = async (c, next) => {
      order.push("outer-before");
      const r = await next();
      order.push("outer-after");
      return r ? { ...r, system: (r.system ?? "") + " + outer" } : r;
    };
    const inner: PrepareStepMiddleware = async () => {
      order.push("inner");
      return { system: "inner" };
    };
    const fn = composePrepareStep([outer, inner]);
    const r = await fn(ctx({}));
    expect(order).toEqual(["outer-before", "inner", "outer-after"]);
    expect(r?.system).toBe("inner + outer");
  });

  it("中间件可短路（不调 next → 后续中间件不执行）", async () => {
    const order: string[] = [];
    const blocker: PrepareStepMiddleware = async () => {
      order.push("blocker");
      return { system: "blocked" };
    };
    const neverRuns: PrepareStepMiddleware = async () => {
      order.push("never");
      return { system: "never" };
    };
    const fn = composePrepareStep([blocker, neverRuns]);
    const r = await fn(ctx({}));
    expect(order).toEqual(["blocker"]);
    expect(r?.system).toBe("blocked");
  });

  it("中间件调 next 但无下游 → next 返回 undefined", async () => {
    const mw: PrepareStepMiddleware = async (_c, next) => {
      const r = await next();
      expect(r).toBeUndefined();
      return { system: "fallback" };
    };
    const fn = composePrepareStep([mw]);
    const r = await fn(ctx({}));
    expect(r?.system).toBe("fallback");
  });

  it("多中间件串联 + 累加 system", async () => {
    const a: PrepareStepMiddleware = async (_c, next) => {
      const r = await next();
      return { system: "A" + (r?.system ? `(${r.system})` : "") };
    };
    const b: PrepareStepMiddleware = async (_c, next) => {
      const r = await next();
      return { system: "B" + (r?.system ? `(${r.system})` : "") };
    };
    const fn = composePrepareStep([a, b]);
    const r = await fn(ctx({}));
    // a 进入先，b 进入后；b 返回 "B"，a 包装 → "A(B)"
    expect(r?.system).toBe("A(B)");
  });
});

describe("stepBudgetWarnMiddleware", () => {
  it("无 budget → 不注入（向后兼容）", async () => {
    const fn = composePrepareStep([stepBudgetWarnMiddleware]);
    const r = await fn(ctx({ stepNumber: 9 })); // 无 budget
    expect(r).toBeUndefined();
  });

  it("ramp_up 阶段 → 不注入", async () => {
    const fn = composePrepareStep([stepBudgetWarnMiddleware]);
    const r = await fn(ctx({ budget: rampUpBudget }));
    expect(r?.system).toBeUndefined();
  });

  it("focus 阶段 → 不注入", async () => {
    const fn = composePrepareStep([stepBudgetWarnMiddleware]);
    const r = await fn(ctx({ budget: focusBudget }));
    expect(r?.system).toBeUndefined();
  });

  it("wrap_up 阶段 → 注入步数预警", async () => {
    const fn = composePrepareStep([stepBudgetWarnMiddleware]);
    const r = await fn(ctx({ budget: wrapUpBudget }));
    expect(r?.system).toBeDefined();
    expect(r!.system!).toContain("步数预警");
    expect(r!.system!).toContain("9/10");
    expect(r!.system!).toContain("nexus_finalize");
  });

  it("wrap_up + 下游已产出 system → 追加（不覆盖）", async () => {
    // stepBudgetWarn 在前（外层），下游在后；外层先进入 → 调 next → 下游产出 → 外层包装追加
    const downstream: PrepareStepMiddleware = async () => ({ system: "## 方法论" });
    const fn = composePrepareStep([stepBudgetWarnMiddleware, downstream]);
    const r = await fn(ctx({ budget: wrapUpBudget }));
    expect(r?.system).toContain("## 方法论");
    expect(r?.system).toContain("步数预警");
  });
});
