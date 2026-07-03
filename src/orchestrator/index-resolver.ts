/**
 * IndexToolResolver（L3 工具解析层 —— 索引解析档）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md §3.2 档位 ①。
 *
 * 数据源：企业工具索引（data/tool-semantic-index.json）。
 * 由实施时初始化，或从 FlowConnector.semanticTags 派生。
 * 命中即返回，source="index"，confidence=1.0。
 */
import { readFileSync, existsSync } from "node:fs";
import type { ToolResolver, ResolvedTool, IndexEntry } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";

/** 索引文件结构（两种兼容格式）。 */
interface IndexFile {
  version: string;
  enterprise?: string;
  /** 旧格式：entries 数组。 */
  entries?: Array<IndexEntry & { semantic: string }>;
  /** syncToolIndex 写出的格式：tools 数组（含 semanticTags）。 */
  tools?: Array<{ name: string; semanticTags?: string[] }>;
}

/**
 * 索引解析器：按 semantic → 工具名 直接查表（最快档）。
 *
 * 兼容两种索引格式：
 *   ① data/tool-semantic-index.json（entries 数组，显式 semantic → toolName）
 *   ② data/relos-mock/tool-index.json（tools 数组 + semanticTags，由 syncToolIndex 写出）
 */
export class IndexToolResolver implements ToolResolver {
  private index: Map<string, IndexEntry[]>;

  constructor(indexPath = "data/relos-mock/tool-index.json") {
    this.index = this.loadIndex(indexPath);
  }

  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    const entries = this.index.get(need.semantic);
    if (!entries || entries.length === 0) return null;

    // 取 primary 标记的，否则取第一个
    const entry = entries.find((e) => e.primary) ?? entries[0]!;
    if (!entry) return null;

    return {
      toolName: entry.toolName,
      params: {},
      ...(entry.fieldMap ? { fieldMap: entry.fieldMap } : {}),
      source: "index",
      confidence: 1.0,
    };
  }

  async resolveBatch(needs: SemanticNeed[], ctx: BizContext): Promise<ResolvedTool[]> {
    const results: ResolvedTool[] = [];
    for (const need of needs) {
      const resolved = await this.resolve(need, ctx);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /** 加载索引文件（失败降级为空 map）。兼容 entries 与 tools 两种格式。 */
  private loadIndex(indexPath: string): Map<string, IndexEntry[]> {
    const map = new Map<string, IndexEntry[]>();
    try {
      if (!existsSync(indexPath)) return map;
      const raw = readFileSync(indexPath, "utf8");
      const data = JSON.parse(raw) as IndexFile;

      // 格式 ①：entries 数组（显式 semantic → toolName，可含 primary/fieldMap）
      for (const e of data.entries ?? []) {
        const { semantic, ...rest } = e;
        const list = map.get(semantic) ?? [];
        list.push(rest);
        map.set(semantic, list);
      }

      // 格式 ②：tools 数组 + semanticTags（由 syncToolIndex 写出，反推 semantic → toolName）
      // 同一 semantic 多个工具时，按工具注册顺序保留，不标 primary（resolve 取第一个）
      for (const t of data.tools ?? []) {
        if (!t.name || !Array.isArray(t.semanticTags)) continue;
        for (const semantic of t.semanticTags) {
          const list = map.get(semantic) ?? [];
          // 避免重复登记（entries 格式已登记过的跳过）
          if (!list.some((e) => e.toolName === t.name)) {
            list.push({ toolName: t.name });
          }
          map.set(semantic, list);
        }
      }
    } catch {
      // 加载失败降级为空（LLM 兜底解析）
    }
    return map;
  }
}
