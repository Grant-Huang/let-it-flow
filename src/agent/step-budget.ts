/**
 * 步数预算管理（R4 平台基础设施）。
 *
 * 把 NexusOps prepare-step.ts:182-186 和 preconditions.ts:284-294 的步数比例
 * 分级逻辑（40/40/20）回归到平台层。
 *
 * 设计：
 *   - 纯函数，零副作用，易测试
 *   - phase 阈值与 NexusOps 现有硬编码完全一致（0.4 / 0.8）
 *   - 通过 PrepareStepContext.budget 透传给应用层
 *
 * 用途：
 *   - prepareStep 钩子读取 phase 决定提示策略（ramp_up 全量、focus 聚焦、wrap_up 强制收口）
 *   - stepBudgetWarnMiddleware（R6）读取 phase=wrap_up 注入步数预警
 */
export interface StepBudget {
  /** 总步数预算（= stopPolicy.maxSteps）。 */
  total: number;
  /** 已执行步数（= stepNumber）。 */
  used: number;
  /** 剩余步数（含当前步，至少 1）。 */
  remaining: number;
  /** used / total，[0, ∞)，>1 表示已超预算。 */
  ratio: number;
  /** 三阶段：ramp_up（0-40%）、focus（40-80%）、wrap_up（80-100%+）。 */
  phase: "ramp_up" | "focus" | "wrap_up";
}

/** ramp_up → focus 的阈值（与 NexusOps preconditions.ts:285 一致）。 */
const FOCUS_THRESHOLD = 0.4;

/** focus → wrap_up 的阈值（与 NexusOps preconditions.ts:288 + prepare-step.ts:182 一致）。 */
const WRAP_UP_THRESHOLD = 0.8;

/**
 * 计算当前步数预算。
 *
 * @param stepNumber  当前步序号（零基或一基均可，语义上是"已用步数"）
 * @param maxSteps    最大步数（stopPolicy.maxSteps）
 * @returns           StepBudget（phase 已计算）
 */
export function computeStepBudget(stepNumber: number, maxSteps: number): StepBudget {
  const total = maxSteps;
  const used = stepNumber;
  // remaining 含当前步（当前步尚未完成），至少 1 防负数
  const remaining = Math.max(1, total - used + 1);
  const ratio = total > 0 ? used / total : 1;

  let phase: StepBudget["phase"];
  if (ratio < FOCUS_THRESHOLD) {
    phase = "ramp_up";
  } else if (ratio < WRAP_UP_THRESHOLD) {
    phase = "focus";
  } else {
    phase = "wrap_up";
  }

  return { total, used, remaining, ratio, phase };
}
