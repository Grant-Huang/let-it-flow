/**
 * Governance hooks 框架（G 层机制 —— 平台提供挂钩点，应用挂阻断规则）。
 *
 * 来自资料洞察："在 prompt 里告诉 agent 遵循我们的规范，
 * 和接入一个当规范被违反时直接阻断的 linter，本质上是两件不同的事。
 * 前者依赖概率性合规，后者强制确定性约束。"
 *
 * 两类挂钩点：
 *   - preToolUse（GovernanceChain）：工具执行前，按入参/risk 阻断
 *   - postToolUse（PostToolUseChain）：工具执行后，按结果做一致性校验
 *     （证据冲突、置信度兜底等），可 warn（注入提示）或 block（替换结果）
 *
 * 平台只提供"挂钩子"；应用挂什么规则由应用决定（如 NexusOps 声明
 * "destructive 需双确认"、"inferred 证据被当结论需 warn"）。
 */
import type { GovernanceHooks } from "./types.js";

/** 单条 preToolUse governance 规则。 */
export interface GovernanceRule {
  id: string;
  description: string;
  /**
   * 工具执行前检查。返回 allow=false 则阻断。
   * @param toolName  工具名
   * @param args      工具入参
   * @param risk      工具风险评级（safe/write/destructive）
   */
  check: (
    toolName: string,
    args: unknown,
    risk: "safe" | "write" | "destructive",
  ) => { allow: true } | { allow: false; reason: string };
}

/**
 * Governance 规则链。
 * harness 在每个工具执行前（tool-adapter 内）调用 preToolUse，
 * 任一规则阻断即拒绝执行。
 */
export class GovernanceChain {
  private readonly rules: GovernanceRule[] = [];

  add(rule: GovernanceRule): void {
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new Error(`governance rule 已存在：${rule.id}`);
    }
    this.rules.push(rule);
  }

  /**
   * 全链检查。
   * @returns 全部放行返回 {allow:true}；否则返回首个阻断理由
   */
  preToolUse(
    toolName: string,
    args: unknown,
    risk: "safe" | "write" | "destructive" = "safe",
  ): { allow: true } | { allow: false; reason: string; ruleId: string } {
    for (const rule of this.rules) {
      const r = rule.check(toolName, args, risk);
      if (!r.allow) {
        return { allow: false, reason: r.reason, ruleId: rule.id };
      }
    }
    return { allow: true };
  }

  /** 转成 GovernanceHooks（仅 preToolUse；需 postToolUse 用 governanceToHooks）。 */
  toHooks(): GovernanceHooks {
    return {
      preToolUse: (
        toolName: string,
        args: unknown,
        risk: "safe" | "write" | "destructive" = "safe",
      ) => this.preToolUse(toolName, args, risk),
    };
  }
}

/** postToolUse 检查结果。 */
export type PostToolUseVerdict =
  | { pass: true }
  | { pass: false; reason: string; severity: "warn" | "block"; ruleId: string };

/** 单条 postToolUse governance 规则（过程侧一致性校验）。 */
export interface PostToolUseRule {
  id: string;
  description: string;
  /**
   * 工具执行后、结果返回 LLM 前检查。
   * @returns
   *   - { pass: true }：放行
   *   - { pass: false, severity: "warn" }：注入 _warnings（LLM 可见，不阻断）
   *   - { pass: false, severity: "block" }：替换结果为 { blocked: true, reason }
   */
  check: (
    toolName: string,
    args: unknown,
    result: unknown,
  ) =>
    | { pass: true }
    | { pass: false; reason: string; severity?: "warn" | "block" };
}

type FailedPostToolUseVerdict = Extract<PostToolUseVerdict, { pass: false }>;

/**
 * PostToolUse 规则链（过程侧一致性校验）。
 *
 * 与 GovernanceChain 对称：收集所有 warn（合并注入），
 * 任一 block 即替换结果。harness 在 tool-adapter 内工具执行后调用。
 */
export class PostToolUseChain {
  private readonly rules: PostToolUseRule[] = [];

  add(rule: PostToolUseRule): void {
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new Error(`postToolUse rule 已存在：${rule.id}`);
    }
    this.rules.push(rule);
  }

  /**
   * 全链检查：收集所有 warn（合并），首个 block 即终止返回 block。
   * @returns 首个 block；否则返回合并的 warn 列表（可能为空 = 全放行）
   */
  postToolUse(
    toolName: string,
    args: unknown,
    result: unknown,
  ): { block?: FailedPostToolUseVerdict; warns: FailedPostToolUseVerdict[] } {
    const warns: FailedPostToolUseVerdict[] = [];
    for (const rule of this.rules) {
      const r = rule.check(toolName, args, result);
      if (!r.pass) {
        const severity = r.severity ?? "warn";
        const verdict: PostToolUseVerdict = {
          pass: false,
          reason: r.reason,
          severity,
          ruleId: rule.id,
        };
        if (severity === "block") {
          return { block: verdict, warns };
        }
        warns.push(verdict);
      }
    }
    return { warns };
  }
}

/**
 * 合并 preToolUse + postToolUse 为 GovernanceHooks。
 * 应用 boot.ts 用此把两条链一起注入 harness。
 */
export function governanceToHooks(
  preChain: GovernanceChain,
  postChain?: PostToolUseChain,
): GovernanceHooks {
  const hooks: GovernanceHooks = {
    preToolUse: (
      toolName: string,
      args: unknown,
      risk: "safe" | "write" | "destructive" = "safe",
    ) => preChain.preToolUse(toolName, args, risk),
  };
  if (postChain) {
    hooks.postToolUse = (toolName: string, args: unknown, result: unknown) => {
      const r = postChain.postToolUse(toolName, args, result);
      if (r.block) {
        return { pass: false, reason: r.block.reason, severity: "block" };
      }
      if (r.warns.length > 0) {
        return {
          pass: false,
          reason: r.warns.map((w) => w.reason).join("; "),
          severity: "warn",
        };
      }
      return { pass: true };
    };
  }
  return hooks;
}
