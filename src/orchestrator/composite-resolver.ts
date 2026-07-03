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
import type { ToolResolver, ResolvedTool } from "./tool-resolver.js";
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
}
