/**
 * OrchestratorFactory（L2 知识层 —— 工厂装配）。
 *
 * 设计见 apps/nexusops/docs/architecture/01-orchestrator-design.md §5。
 *
 * 核心原则（D9）：工厂返回 Orchestrator 接口，调用方不感知具体实现。
 *
 * 本期实现：直接返回 MockOrchestrator（本地 JSON 规则，source=mock）。
 *
 * 未来扩展点（结构已预留，本期不实现）：
 *   当 relos 就绪时，把单层 Mock 改为 FallbackChain：
 *     createOrchestrator 内部变为：
 *       new FallbackChain([cacheLayer, relosOrchestrator, mockOrchestrator])
 *     调用方（boot.ts）代码零改动。
 */
import type { Orchestrator } from "./types.js";
import { MockOrchestrator } from "./mock-orchestrator.js";

/** 工厂选项。 */
export interface OrchestratorOptions {
  /**
   * Mock 规则数据目录（缺省 data/relos-mock）。
   * 未来扩展：relosBaseURL / relosApiKey / cacheTTL 等会加到这里。
   */
  dataDir?: string;
}

/**
 * 创建 Orchestrator 实例。
 *
 * 本期：返回 MockOrchestrator。
 * 未来：返回 FallbackChain（CacheLayer → RelosOrchestrator → MockOrchestrator）。
 *
 * @param opts  工厂选项
 * @returns     Orchestrator 实例（调用方不感知具体实现）
 */
export function createOrchestrator(opts: OrchestratorOptions = {}): Orchestrator {
  // ── 本期实现：直接 MockOrchestrator ──────────────────────────────────
  // 未来 relos 就绪时，这里改为：
  //   const mock = new MockOrchestrator(opts.dataDir ?? "data/relos-mock");
  //   const relos = new RelosOrchestrator({ baseURL: opts.relosBaseURL!, ... });
  //   const cache = new CacheLayer({ ttl: opts.cacheTTL ?? 300, ... });
  //   return new FallbackChain([cache, relos, mock]);
  return new MockOrchestrator(opts.dataDir ?? "data/relos-mock");
}
