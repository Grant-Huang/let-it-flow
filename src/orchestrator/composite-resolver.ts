/**
 * CompositeToolResolver（L3 工具解析层 —— 三档组合）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md §3.2。
 *
 * 组合 IndexToolResolver + LlmToolResolver（三档解析）：
 *   1. 索引命中（快，source="index"，confidence=1.0）
 *   2. LLM 推理（慢，source="llm"，confidence=0.7）
 *   3. 返回 null（数据不可用，分析继续不崩溃）
 */
import type { ToolResolver, ResolvedTool, ReloadableResolver } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";

/**
 * 组合解析器：按优先级依次尝试多个 resolver，命中即返回。
 */
export class CompositeToolResolver implements ToolResolver {
  private readonly resolvers: ToolResolver[];
  private readonly cache: Map<string, ResolvedTool | null> = new Map();

  constructor(resolvers: ToolResolver[]) {
    this.resolvers = resolvers;
  }

  async resolve(need: SemanticNeed, ctx: BizContext): Promise<ResolvedTool | null> {
    // 会话内缓存（同 semantic 不重复解析）
    const cacheKey = need.semantic;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    // 按优先级依次尝试
    for (const resolver of this.resolvers) {
      const result = await resolver.resolve(need, ctx);
      if (result) {
        this.cache.set(cacheKey, result);
        return result;
      }
    }

    this.cache.set(cacheKey, null);
    return null;
  }

  async resolveBatch(needs: SemanticNeed[], ctx: BizContext): Promise<ResolvedTool[]> {
    const results: ResolvedTool[] = [];
    for (const need of needs) {
      const resolved = await this.resolve(need, ctx);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /** 清除缓存（测试用）。 */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 联动刷新所有子 resolver + 清空会话缓存（运行时定时刷新用）。
   *
   * catalog 预热重写本地索引后，boot 的 setInterval 会调用本方法：
   *   1. 对每个实现了 ReloadableResolver 的子 resolver 调 reload()
   *   2. 清空本层会话缓存（旧 semantic → 旧 toolName 映射全部失效）
   *
   * 非破坏性：未实现 reload() 的子 resolver（如 KpiResolver/LlmToolResolver）跳过。
   */
  reload(): void {
    for (const r of this.resolvers) {
      const reloadable = r as Partial<ReloadableResolver>;
      if (typeof reloadable.reload === "function") {
        reloadable.reload();
      }
    }
    this.clearCache();
  }
}
