/**
 * Governance hooks 框架（G 层机制 —— 平台提供挂钩点，应用挂阻断规则）。
 *
 * 来自资料洞察："在 prompt 里告诉 agent 遵循我们的规范，
 * 和接入一个当规范被违反时直接阻断的 linter，本质上是两件不同的事。
 * 前者依赖概率性合规，后者强制确定性约束。"
 *
 * 平台只提供"挂钩子"：GovernanceChain 维护规则列表 + 提供 preToolUse 入口。
 * 应用挂什么规则由应用决定（如 NexusOps 声明"停线操作需双确认"）。
 */
import type { GovernanceHooks } from "./types.js";

/** 单条 governance 规则。 */
export interface GovernanceRule {
  id: string;
  description: string;
  /** 工具执行前检查。返回 allow=false 则阻断。 */
  check: NonNullable<GovernanceHooks["preToolUse"]>;
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
  ): { allow: true } | { allow: false; reason: string; ruleId: string } {
    for (const rule of this.rules) {
      const r = rule.check(toolName, args);
      if (!r.allow) {
        return { allow: false, reason: r.reason, ruleId: rule.id };
      }
    }
    return { allow: true };
  }

  /** 转成 GovernanceHooks（供 harness 注入 tool-adapter）。 */
  toHooks(): GovernanceHooks {
    return {
      preToolUse: (toolName: string, args: unknown) => this.preToolUse(toolName, args),
    };
  }
}
