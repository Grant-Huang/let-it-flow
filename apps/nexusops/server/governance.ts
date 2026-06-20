/**
 * NexusOps 业务治理规则（G 层内容 —— 应用声明，平台 GovernanceChain 执行）。
 *
 * 来自设计："在 prompt 里告诉 agent 遵循规范，和接入一个规范被违反时直接阻断的 linter，
 * 本质是两件不同的事。前者概率性合规，后者强制确定性约束。"
 *
 * 规则挂在 harness 的 PreToolUse 钩子上：每个工具执行前过一遍链，
 * 任一阻断即拒绝该次调用（不发请求）。
 *
 * 钩子签名收 (toolName, args, risk)：risk 来自 connector.risk（safe/write/destructive），
 * 平台 tool-adapter 透传，应用据此做确定性阻断。
 */
import { GovernanceChain } from "../../../src/agent/governance.js";
import type { GovernanceRule } from "../../../src/agent/governance.js";

/** 工具风险评级（与 FlowConnector.risk 对齐）。 */
type Risk = "safe" | "write" | "destructive";

/**
 * 构造 NexusOps 治理链。
 *
 * 重点关注破坏性/写入操作（停线、批量改排产、删除）：
 *   - destructive 工具（停线/删除/终止）默认确定性阻断，除非显式开关
 *     NEXUS_ALLOW_DESTRUCTIVE=1 打开（此时仍需 HITL，由 tool-adapter 的
 *     requireConfirmation 兜底）。
 *   - 批量排产变更（单次 >3 工单）确定性阻断。
 */
export function buildNexusGovernance(): GovernanceChain {
  const chain = new GovernanceChain();
  const allowDestructive = process.env.NEXUS_ALLOW_DESTRUCTIVE === "1";

  // 规则 1：destructive 工具默认全确定性阻断（除非显式开关打开）。
  // 即使开关打开，HITL 门仍由 tool-adapter 的 requireConfirmation 兜底确认。
  chain.add({
    id: "block_destructive_by_default",
    description:
      "destructive 工具（停线/删除/终止）默认阻断自动执行，需 NEXUS_ALLOW_DESTRUCTIVE=1 + HITL",
    check: (_toolName, _args, risk: Risk) => {
      if (risk === "destructive" && !allowDestructive) {
        return {
          allow: false,
          reason:
            "destructive 操作（停线/删除/终止）已被治理规则阻断。如需执行，请设置 NEXUS_ALLOW_DESTRUCTIVE=1 并通过 HITL 确认。",
        };
      }
      return { allow: true };
    },
  } satisfies GovernanceRule);

  // 规则 2：批量排产/物料变更（一次改 >3 条工单/物料）需人工确认
  chain.add({
    id: "guard_bulk_schedule_change",
    description: "批量排产/物料变更（单次 >3 工单或物料项）需走 HITL 确认",
    check: (toolName, args, _risk: Risk) => {
      // 匹配 NexusOps mock 动作工具：schedule_work_order / changeover / reallocate_capacity / material_issue / purchase_request
      const isBulkCandidate =
        /mcp\.mes\.(schedule_work_order|changeover|reallocate_capacity)|mcp\.erp\.(material_issue|purchase_request)/.test(
          toolName,
        );
      if (!isBulkCandidate) return { allow: true };
      const a = (args ?? {}) as { orderIds?: unknown; items?: unknown; qty?: unknown; count?: unknown };
      const bulk =
        (Array.isArray(a.orderIds) && (a.orderIds as unknown[]).length > 3) ||
        (Array.isArray(a.items) && (a.items as unknown[]).length > 3) ||
        (typeof a.qty === "number" && a.qty > 1000) ||
        (typeof a.count === "number" && a.count > 3);
      if (bulk) {
        return {
          allow: false,
          reason: "批量变更（>3 工单/物料项 或 qty>1000）属高风险操作，已被治理规则阻断。请拆分为小批量后重试，或由主管人工执行。",
        };
      }
      return { allow: true };
    },
  } satisfies GovernanceRule);

  // 规则 3：EHS 安全护栏 —— 任何 destructive 动作（停线/批量报废）必须同时满足
  // (a) NEXUS_ALLOW_DESTRUCTIVE=1 开关 + (b) HITL 确认（tool-adapter 兜底）。
  // 规则 1 已对 destructive 做确定性阻断；此规则作为"合理识别不合理"的语义层：
  // 即使开关打开，仍要求 reason 字段非空（无理由的停线/报废直接拒）。
  chain.add({
    id: "guard_unjustified_destructive",
    description: "destructive 动作（停线/报废）必须有明确 reason 字段，否则阻断",
    check: (toolName, args, risk: Risk) => {
      if (risk !== "destructive") return { allow: true };
      const isDestructiveAction = /mcp\.(eam\.stop_line|qms\.scrap_batch)/.test(toolName);
      if (!isDestructiveAction) return { allow: true };
      const a = (args ?? {}) as { reason?: unknown };
      const reason = typeof a.reason === "string" ? a.reason.trim() : "";
      if (reason.length < 4) {
        return {
          allow: false,
          reason: "destructive 动作（停线/批量报废）必须提供具体 reason（≥4 字）。无理由的高危操作已被 EHS 治理规则阻断。",
        };
      }
      return { allow: true };
    },
  } satisfies GovernanceRule);

  return chain;
}
