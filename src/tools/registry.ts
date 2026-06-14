import type { FlowConnector, ToolTier } from "./base.js";

/**
 * 分层工具注册表（见 04 §4.11）。
 *
 * MVP 仅实装粗筛：按 tier 列出工具（core/domain/custom）。
 * 向量精排（two-stage 的第二阶段）留给后续里程碑 —— 计划明确"不做向量精排"。
 *
 * 用法：
 *   const reg = new ToolRegistry();
 *   reg.register(webSearch);
 *   reg.listByTier("core"); // → [webSearch, ...]
 *   reg.get("core.web_search"); // → webSearch
 */
export class ToolRegistry {
  private readonly byName = new Map<string, FlowConnector>();

  /** 注册一个工具（重复 name 抛错）。 */
  register(tool: FlowConnector): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
  }

  /** 按名查找。 */
  get(name: string): FlowConnector | undefined {
    return this.byName.get(name);
  }

  /** 是否已注册。 */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** 列出全部工具。 */
  list(): FlowConnector[] {
    return [...this.byName.values()];
  }

  /** 按 tier 粗筛（two-stage 的第一阶段）。 */
  listByTier(tier: ToolTier): FlowConnector[] {
    return this.list().filter((t) => t.tier === tier);
  }

  /** 列出多个 tier 的并集。 */
  listByTiers(tiers: ToolTier[]): FlowConnector[] {
    const set = new Set(tiers);
    return this.list().filter((t) => set.has(t.tier));
  }
}
