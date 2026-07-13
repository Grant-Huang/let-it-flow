/**
 * IndexToolResolver（L3 工具解析层 —— 索引解析档）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md §3.2 档位 ①。
 *
 * 数据源：企业工具索引（data/tool-semantic-index.json）。
 * 由实施时初始化，或从 FlowConnector.semanticTags 派生。
 * 命中即返回，source="index"，confidence 由 entry.confidence 决定：
 *   - 人工维护的精确登记（source=manual 或缺省）→ 1.0
 *   - catalog 派生（source=derived_catalog）→ 0.9
 *   - tools 数组反推（source=derived_local）→ 0.9
 * 写入方可通过 entry.confidence 显式覆盖以上默认值。
 */
import { readFileSync, existsSync } from "node:fs";
import type { ToolResolver, ResolvedTool, IndexEntry, ReloadableResolver, EntrySource } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";

/** 由 entry 来源推断缺省置信度。 */
function defaultConfidenceBySource(source: EntrySource | undefined): number {
  switch (source) {
    case "derived_catalog":
    case "derived_local":
      return 0.9;
    case "manual":
    default:
      return 1.0;
  }
}

/** 解析 entry 的最终置信度：写入方显式优先，否则按来源推断。 */
function resolveEntryConfidence(entry: IndexEntry): number {
  if (typeof entry.confidence === "number" && !Number.isNaN(entry.confidence)) {
    return entry.confidence;
  }
  return defaultConfidenceBySource(entry.source);
}

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
export class IndexToolResolver implements ReloadableResolver {
  private readonly indexPath: string;
  private index: Map<string, IndexEntry[]>;

  constructor(indexPath = "data/relos-mock/tool-index.json") {
    this.indexPath = indexPath;
    this.index = this.loadIndex(indexPath);
  }

  /**
   * 重新加载索引文件（运行时定时刷新用）。
   *
   * 当 catalog 预热重写 tool-index.json 后，boot 的 setInterval 刷新会调用本方法，
   * 让 IndexToolResolver 的内存 Map 同步到磁盘最新内容。
   */
  reload(): void {
    this.index = this.loadIndex(this.indexPath);
  }

  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    // 归一化：驼峰/大写/混合大小写统一转小写（planAchievement → planachievement）
    // 进一步：驼峰转下划线（planAchievement → plan_achievement）尝试二次查找
    const raw = need.semantic;
    const lower = raw.toLowerCase();
    const snake = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

    let entries = this.index.get(lower) ?? this.index.get(snake);
    if (!entries || entries.length === 0) return null;

    // 取 primary 标记的，否则取第一个
    const entry = entries.find((e) => e.primary) ?? entries[0]!;
    if (!entry) return null;

    return {
      toolName: entry.toolName,
      params: {},
      ...(entry.fieldMap ? { fieldMap: entry.fieldMap } : {}),
      source: "index",
      confidence: resolveEntryConfidence(entry),
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
        const key = semantic.toLowerCase();
        const list = map.get(key) ?? [];
        list.push(rest);
        map.set(key, list);
      }

      // 格式 ②：tools 数组 + semanticTags（由 syncToolIndex 写出，反推 semantic → toolName）
      // 同一 semantic 多个工具时，按工具注册顺序保留，不标 primary（resolve 取第一个）
      // 这类 entry 是从 tools 的 semanticTags 反推的，无显式 semantic→toolName 登记，
      // 标 source="derived_local"，confidence 缺省 0.9（非人工精确登记）
      for (const t of data.tools ?? []) {
        if (!t.name || !Array.isArray(t.semanticTags)) continue;
        for (const semantic of t.semanticTags) {
          const key = semantic.toLowerCase();
          const list = map.get(key) ?? [];
          // 避免重复登记（entries 格式已登记过的跳过）
          if (!list.some((e) => e.toolName === t.name)) {
            list.push({ toolName: t.name, source: "derived_local", confidence: 0.9 });
          }
          map.set(key, list);
        }
      }
    } catch {
      // 加载失败降级为空（LLM 兜底解析）
    }
    return map;
  }
}
