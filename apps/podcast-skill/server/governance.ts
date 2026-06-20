/**
 * Podcast-Skill 治理规则（G 内容）。
 *
 * 主要防止成本失控：
 *   - core.web_fetch 单次 URL 数 >5 阻断（强制拆分或人工确认）
 */
import { GovernanceChain } from "../../../src/agent/governance.js";
import type { GovernanceRule } from "../../../src/agent/governance.js";

export function buildPodcastSkillGovernance(): GovernanceChain {
  const chain = new GovernanceChain();

  chain.add({
    id: "guard_bulk_web_fetch",
    description: "core.web_fetch 单次抓取 URL 数 >5 时阻断（避免成本失控）",
    check: (toolName, args) => {
      if (toolName !== "core.web_fetch") return { allow: true };
      const a = (args ?? {}) as { urls?: unknown; url?: unknown };
      const count =
        Array.isArray(a.urls) ? (a.urls as unknown[]).length : a.url ? 1 : 0;
      if (count > 5) {
        return {
          allow: false,
          reason: `单次 web_fetch URL 数 ${count} 超过上限 5，请拆分为多次调用。`,
        };
      }
      return { allow: true };
    },
  } satisfies GovernanceRule);

  return chain;
}
