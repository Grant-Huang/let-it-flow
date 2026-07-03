/**
 * CatalogSearchResolver —— 在线 catalog 兜底解析器（07-mestar-integration-spec.md §2 第⑤层）。
 *
 * 职责：当 Index/Embedding/LLM 都未命中时，作为最后一道兜底，
 * 调用 mestar.catalog.search 在线搜索候选工具，命中后派生 semantic 回写本地索引。
 *
 * 设计意图：catalog 全量预热可能遗漏新增/罕见工具。在线兜底保证
 * "即使没缓存也能找到"，并把结果回写到本地索引（下次走 Index 命中）。
 *
 * 失败降级：mestar 不可达或搜索无结果 → 返回 null（分析继续不崩溃）。
 */
import type { ToolResolver, ResolvedTool } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";
import type { McpClient, McpToolCallResult } from "../tools/mcp/mcp-client.js";
import { deriveSemantic, type CatalogItem } from "../tools/mcp/mcp-catalog-cache.js";

/** 构造选项。 */
export interface CatalogSearchResolverOptions {
  /** MCP server id。 */
  serverId: string;
  /** 已连接的 MCP 客户端。 */
  client: McpClient;
  /** 回写本地索引的回调（boot 时注入 McpCatalogCache 的写方法）。 */
  onResolved?: (toolName: string, semantic: string) => void;
}

/**
 * 在线 catalog 搜索兜底解析器。
 *
 * 不参与启动时构建（被动触发），不持有缓存状态。
 * 每次调用都走 mestar.catalog.search（慢，约 200-500ms）。
 */
export class CatalogSearchResolver implements ToolResolver {
  private readonly serverId: string;
  private readonly client: McpClient;
  private readonly onResolved?: (toolName: string, semantic: string) => void;

  constructor(opts: CatalogSearchResolverOptions) {
    this.serverId = opts.serverId;
    this.client = opts.client;
    this.onResolved = opts.onResolved;
  }

  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    const query = need.description ?? need.semantic;
    try {
      const items = await this.searchCatalog(query, 5);
      if (items.length === 0) return null;

      // 优先选 executable + readOnly 的
      const preferred =
        items.find((i) => i.executable && i.risk === "readOnly") ?? items[0]!;
      if (!preferred) return null;

      // 派生 semantic 并回写本地索引（下次走 Index 命中）
      const tags = deriveSemantic(preferred);
      const semantic = tags[0] ?? need.semantic;
      this.onResolved?.(preferred.name, semantic);

      return {
        toolName: preferred.name,
        params: {},
        source: "fallback",
        confidence: 0.6, // 在线搜索结果置信度低于 Index/LLM
      };
    } catch {
      // mestar 不可达或解析失败 → null
      return null;
    }
  }

  async resolveBatch(needs: SemanticNeed[], ctx: BizContext): Promise<ResolvedTool[]> {
    const results: ResolvedTool[] = [];
    for (const need of needs) {
      const resolved = await this.resolve(need, ctx);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /** 调 mestar.catalog.search 在线搜索。 */
  private async searchCatalog(query: string, limit: number): Promise<CatalogItem[]> {
    const result: McpToolCallResult = await this.client.callTool("mestar.catalog.search", {
      query,
      limit,
    });

    // 优先读 structuredContent
    const structured = (result as { structuredContent?: { items?: CatalogItem[] } }).structuredContent;
    if (structured?.items) return structured.items;

    // 兜底：从 text 解析
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      const parsed = JSON.parse(text) as { items?: CatalogItem[] };
      return parsed.items ?? [];
    } catch {
      return [];
    }
  }
}
