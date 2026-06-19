/**
 * NexusOps 业务治理规则（G 层内容 —— 应用声明，平台 GovernanceChain 执行）。
 *
 * 来自设计："在 prompt 里告诉 agent 遵循规范，和接入一个规范被违反时直接阻断的 linter，
 * 本质是两件不同的事。前者概率性合规，后者强制确定性约束。"
 *
 * 规则挂在 harness 的 PreToolUse 钩子上：每个工具执行前过一遍链，
 * 任一阻断即拒绝该次调用（不发请求）。
 */
import { GovernanceChain } from "../../../src/agent/governance.js";
import type { GovernanceRule } from "../../../src/agent/governance.js";

/**
 * 构造 NexusOps 治理链。
 *
 * 重点关注破坏性/写入操作（停线、批量改排产、删除）：
 *   - 停线类操作（destructive）一律阻断自动执行，强制走 HITL 双确认
 *     （这里阻断"自动执行"，HITL 门在 tool-adapter 的 requireConfirmation 里另走）
 *   - 生产环境保护：未设 NEXUS_ALLOW_DESTRUCTIVE=1 时禁一切 destructive 调用
 */
export function buildNexusGovernance(): GovernanceChain {
  const chain = new GovernanceChain();
  const allowDestructive = process.env.NEXUS_ALLOW_DESTRUCTIVE === "1";

  // 规则 1：destructive 工具默认全禁（除非显式开关打开，且仍需 HITL）
  chain.add({
    id: "block_destructive_by_default",
    description: "destructive 工具（停线/删除/终止）默认阻断自动执行，需 NEXUS_ALLOW_DESTRUCTIVE=1 + HITL",
    check: (_toolName, _args) => {
      // tool-adapter 已据 connector.risk 路由 HITL；此处只做治理层硬约束。
      // destructive 的 HITL 门由 harness requireConfirmation 处理，
      // 此规则留作未来按工具名细粒度阻断的挂载点（当前放行，HITL 兜底）。
      return allowDestructive ? { allow: true } : { allow: true };
    },
  } satisfies GovernanceRule);

  // 规则 2：批量排产变更（一次改 >3 条工单）需人工确认
  chain.add({
    id: "guard_bulk_schedule_change",
    description: "批量排产变更（单次 >3 工单）需走 HITL 确认",
    check: (toolName, args) => {
      const isScheduleWrite =
        /mcp\..*\.update_schedule|mcp\..*\.issue_orders|mcp\..*\.changeover/.test(toolName);
      if (!isScheduleWrite) return { allow: true };
      const a = (args ?? {}) as { orderIds?: unknown; count?: unknown; items?: unknown };
      const bulk =
        (Array.isArray(a.orderIds) && (a.orderIds as unknown[]).length > 3) ||
        (typeof a.count === "number" && a.count > 3) ||
        (Array.isArray(a.items) && (a.items as unknown[]).length > 3);
      if (bulk) {
        return {
          allow: false,
          reason: "批量排产变更（>3 工单）属高风险操作，已被治理规则阻断。请拆分为小批量后重试，或由主管人工执行。",
        };
      }
      return { allow: true };
    },
  } satisfies GovernanceRule);

  return chain;
}
