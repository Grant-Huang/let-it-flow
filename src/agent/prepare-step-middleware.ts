/**
 * prepareStep 中间件模式（R6 钩子与摘要）。
 *
 * 把 NexusOps prepare-step.ts 集中实现的 5 个职责拆为可组合的中间件链。
 *
 * 设计：
 *   - 洋葱模型（类似 Koa）：外层先进入、后返回，可包装下游结果
 *   - 中间件可短路（不调 next → 后续不执行）
 *   - 平台内置 stepBudgetWarnMiddleware（80% 步数预警，复刻自 NexusOps prepare-step.ts:182-186）
 *
 * 与现有 HarnessConfig.prepareStep 的关系：
 *   - 不破坏现有 API：老的单函数用法继续兼容
 *   - composePrepareStep 是新增 helper：把多个中间件组合成单个 prepareStep 函数
 */
import type { PrepareStepContext, PrepareStepResult } from "./types.js";
import type { StepBudget } from "./step-budget.js";

/**
 * prepareStep 中间件签名（洋葱模型）。
 *
 * @param ctx   当前步骤上下文（含 steps/stepNumber/intent/budget）
 * @param next  调用下游中间件；返回其结果（若无下游则 undefined）
 * @returns     本中间件产出的结果（可包装/修改 next() 的返回）
 */
export type PrepareStepMiddleware = (
  ctx: PrepareStepContext,
  next: () => Promise<PrepareStepResult | undefined>,
) => Promise<PrepareStepResult | undefined>;

/**
 * 把多个中间件组合成单个 prepareStep 函数（兼容 HarnessConfig.prepareStep 签名）。
 *
 * 语义（洋葱模型）：
 *   - 数组首个中间件最先执行，能最先看到 ctx、最后包装结果
 *   - 每个中间件可选择调 next() 进入下游、或短路
 *   - 无中间件或所有中间件都调 next 且无下游 → 返回 undefined
 *
 * @example
 *   const prepareStep = composePrepareStep([
 *     methodologyInjectMiddleware,
 *     domainToolFilterMiddleware,
 *     preconditionReminderMiddleware,
 *     evidenceGateMiddleware,
 *     stepBudgetWarnMiddleware,
 *   ]);
 *   // 传给 HarnessConfig.prepareStep
 */
export function composePrepareStep(
  middlewares: PrepareStepMiddleware[],
): (ctx: PrepareStepContext) => Promise<PrepareStepResult | undefined> {
  return async (ctx: PrepareStepContext): Promise<PrepareStepResult | undefined> => {
    // 从最后一个中间件开始往前包装（首个最先执行）
    let index = 0;
    const dispatch = async (): Promise<PrepareStepResult | undefined> => {
      if (index >= middlewares.length) return undefined;
      const mw = middlewares[index]!;
      index += 1;
      return mw(ctx, dispatch);
    };
    return dispatch();
  };
}

/**
 * 平台内置中间件：步数预警（80% 时强制收口提示）。
 *
 * 复刻自 NexusOps prepare-step.ts:182-186 的逻辑。
 * 当 ctx.budget.phase === "wrap_up" 时，注入"步数预警"提示，
 * 引导 LLM 评估收尾或聚焦最关键缺口。
 *
 * 行为：
 *   - 无 budget（maxSteps 未配置）→ 不注入（向后兼容）
 *   - phase !== "wrap_up" → 不注入
 *   - phase === "wrap_up" → 追加预警 system（不覆盖下游产出）
 */
export const stepBudgetWarnMiddleware: PrepareStepMiddleware = async (ctx, next) => {
  const downstream = await next();
  const budget = ctx.budget;
  if (!budget || budget.phase !== "wrap_up") {
    return downstream;
  }
  const warnText = buildBudgetWarnText(budget);
  const system = downstream?.system ? `${downstream.system}\n\n${warnText}` : warnText;
  return { ...downstream, system };
};

/** 构造步数预警文本（与 NexusOps prepare-step.ts:184 一致）。 */
function buildBudgetWarnText(budget: StepBudget): string {
  return [
    `## 步数预警（已用 ${budget.used}/${budget.total}）`,
    `剩余约 ${budget.remaining} 步。请评估：`,
    "- 证据已支撑结论 → 立即调 nexus_finalize 收尾",
    '- 证据仍缺关键项 → 优先补最关键的 1-2 项（参考上方"证据缺口"），然后收尾',
    "- **不要在剩余步数内启动新的诊断支线**",
  ].join("\n");
}
