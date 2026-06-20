import type { GovernanceChain } from "../../../src/agent/types.js";

/**
 * 构建 podcast-skill 应用的治理规则（G 层）。
 */
export interface GovernanceConfig {
  webFetchMaxUrlPerCall?: number;
}

export function buildPodcastSkillGovernance(config: GovernanceConfig = {}): GovernanceChain {
  const maxUrls = config.webFetchMaxUrlPerCall ?? 5;

  const chain: GovernanceChain = {
    name: "podcast-skill-governance",
    rules: [
      {
        name: "web_fetch_cost_guard",
        phase: "before_tool_call",
        condition: (step) => {
          const tc = step.toolCalls[step.toolCalls.length - 1];
          if (!tc || tc.toolName !== "core.web_fetch") return false;
          // 检查本步内已调用 web_fetch 的 URL 数
          const fetchCalls = step.toolCalls.filter((c) => c.toolName === "core.web_fetch");
          return fetchCalls.length > maxUrls;
        },
        action: (step) => ({
          gate: "requireConfirmation",
          prompt: `已在本步调用 ${maxUrls} 次 web_fetch，继续可能产生高成本。确认继续?`,
        }),
      },
    ],
  };

  return chain;
}
