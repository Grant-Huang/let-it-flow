import { GovernanceChain } from "../../../src/agent/governance.js";

/**
 * 构建 AI Content Factory 应用的治理规则（G 层）。
 *
 * 镜像 apps/nexusops/server/governance.ts 的 GovernanceChain 用法。
 */
export interface GovernanceConfig {
  webFetchMaxUrlPerCall?: number;
}

export function buildAiContentFactoryGovernance(config: GovernanceConfig = {}): GovernanceChain {
  const chain = new GovernanceChain();
  const maxUrls = config.webFetchMaxUrlPerCall ?? 5;

  // 规则：单步内 web_fetch 调用次数超限 → 确定性阻断（避免抓取成本失控）
  // 注：GovernanceChain 的 check 接口是 (toolName, args, risk)，
  // 无法访问 stepTrace，故改为按单次调用阻断——实际成本控制由 tool-adapter 的
  // postToolUse 或 prepareStep 更合适，这里保留一个最小示例规则。
  chain.add({
    id: "web_fetch_empty_urls_guard",
    description: "web_fetch 调用时 urls 和 fromInputRefs 至少其一非空",
    check: (_toolName, args) => {
      if (_toolName !== "core.web_fetch") return { allow: true };
      const a = args as { urls?: unknown[]; fromInputRefs?: unknown[] };
      const hasUrls = Array.isArray(a.urls) && a.urls.length > 0;
      const hasRefs = Array.isArray(a.fromInputRefs) && a.fromInputRefs.length > 0;
      if (!hasUrls && !hasRefs) {
        return { allow: false, reason: "web_fetch 需提供 urls 或 fromInputRefs 至少其一" };
      }
      if (hasUrls && a.urls!.length > maxUrls) {
        return { allow: false, reason: `单次 web_fetch URL 数 ${a.urls!.length} 超过上限 ${maxUrls}` };
      }
      return { allow: true };
    },
  });

  return chain;
}
