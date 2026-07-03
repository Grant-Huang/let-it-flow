/**
 * EmbeddingToolRouter —— 向量检索路由层（07-mestar-integration-spec.md §6）。
 *
 * 职责：把"semantic 需求"或"自然语言描述"向量化，在 catalog 缓存里检索
 * top-K 最相似的候选工具。
 *
 * 在五层解析管道里处于第③层（Index 未命中后、LlmToolResolver 域内选择前）：
 *   - top-1 相似度 > directHitThreshold（0.75）→ 直接返回（省一次 LLM 调用）
 *   - 否则返回 null，让下游 LlmToolResolver 在 top-K 候选里精选
 *
 * 实现简化：catalog 的 executable 工具约 285 个，向量维度 1536，
 * 矩阵约 285×1536×4 ≈ 1.7MB。这个规模不需要向量数据库，
 * 线性扫 cosine 相似度足够快（<10ms）。
 *
 * 依赖：ai SDK 内置 embedMany + cosineSimilarity（零新依赖，D17 决策）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embedMany, cosineSimilarity, type EmbeddingModel } from "ai";
import type { ToolResolver, ResolvedTool } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";
import type { BucketItem } from "../tools/mcp/mcp-catalog-cache.js";

/** 候选工具（检索结果）。 */
export interface CandidateTool {
  /** 工具名（mestar 全名）。 */
  name: string;
  /** 相似度（0-1）。 */
  score: number;
  /** 工具描述（供 LLM 选择）。 */
  title: string;
  desc: string;
}

/** Embedder 抽象（测试可注入 mock；生产用 ai SDK embedMany）。 */
export interface Embedder {
  /** 批量文本转向量。 */
  embed(texts: string[]): Promise<number[][]>;
}

/** 构造选项。 */
export interface EmbeddingToolRouterOptions {
  /** catalog 缓存目录（data/mcp-catalog-cache/<serverId>）。 */
  cacheDir: string;
  /** Embedder 实例（注入便于测试）。 */
  embedder: Embedder;
  /** top-1 相似度高于此值直接返回（缺省 0.75）。 */
  directHitThreshold?: number;
  /** 检索候选数（缺省 5）。 */
  topK?: number;
}

/** 持久化的向量索引文件结构。 */
interface VectorIndexFile {
  serverId: string;
  generatedAt: string;
  dimension: number;
  /** 工具名 + 描述（与向量一一对应）。 */
  items: Array<{ name: string; text: string; title: string; desc: string }>;
  /** 扁平化的向量数据（items.length × dimension）。 */
  vectors: number[];
}

/**
 * 把 ai SDK 的 embedMany + EmbeddingModel 包装成 Embedder。
 * 生产用：const embedder = makeAiEmbedder(model);
 */
export function makeAiEmbedder(model: EmbeddingModel): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings.map((e) => e as unknown as number[]);
    },
  };
}

/**
 * Embedding 路由解析器。
 *
 * 使用方式：
 *   const router = new EmbeddingToolRouter({ cacheDir, embedder });
 *   await router.buildIndex(buckets);         // 启动时构建（持久化）
 *   const candidates = await router.retrieve("device_bom");  // 运行时检索
 */
export class EmbeddingToolRouter implements ToolResolver {
  private readonly cacheDir: string;
  private readonly embedder: Embedder;
  private readonly directHitThreshold: number;
  private readonly topK: number;

  /** 内存中的向量索引（buildIndex/loadIndex 后填充）。 */
  private indexTexts: string[] = [];
  private indexVectors: number[][] = [];
  private indexMeta: Array<{ name: string; title: string; desc: string }> = [];
  /** 是否已就绪（索引构建或加载成功）。 */
  private ready = false;

  constructor(opts: EmbeddingToolRouterOptions) {
    this.cacheDir = opts.cacheDir;
    this.embedder = opts.embedder;
    this.directHitThreshold = opts.directHitThreshold ?? 0.75;
    this.topK = opts.topK ?? 5;
  }

  /** 是否已就绪。 */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * 从分桶清单构建向量索引（启动时调用）。
   * 构建后持久化到 vectors.bin，下次启动直接加载。
   */
  async buildIndex(buckets: BucketItem[]): Promise<void> {
    if (buckets.length === 0) {
      this.ready = false;
      return;
    }

    // 拼接每个工具的可索引文本（title + desc + triggers + semanticTags）
    const texts = buckets.map((b) => this.buildSearchableText(b));
    const meta = buckets.map((b) => ({ name: b.name, title: b.title, desc: b.desc }));

    try {
      const vectors = await this.embedder.embed(texts);
      if (vectors.length !== texts.length) {
        throw new Error(`embedding 数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`);
      }
      this.indexTexts = texts;
      this.indexVectors = vectors;
      this.indexMeta = meta;
      this.ready = true;

      // 持久化
      this.persistIndex();
    } catch (e) {
      console.warn(
        `[embedding-router] 向量索引构建失败，降级跳过：${e instanceof Error ? e.message : String(e)}`,
      );
      this.ready = false;
    }
  }

  /** 从本地加载已持久化的向量索引（启动时优先于 buildIndex）。 */
  loadIndex(): boolean {
    const path = join(this.cacheDir, "vectors.json");
    if (!existsSync(path)) return false;
    try {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw) as VectorIndexFile;
      if (!data.items || !data.vectors || data.items.length === 0) return false;
      const dim = data.dimension;
      this.indexTexts = data.items.map((i) => i.text);
      this.indexMeta = data.items.map((i) => ({ name: i.name, title: i.title, desc: i.desc }));
      // 反扁平化向量
      this.indexVectors = data.items.map((_, i) => data.vectors.slice(i * dim, (i + 1) * dim));
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检索 top-K 候选工具。
   * @returns 按相似度降序的候选列表（可能为空）
   */
  async retrieve(query: string, topK?: number): Promise<CandidateTool[]> {
    if (!this.ready || this.indexVectors.length === 0) return [];
    const k = topK ?? this.topK;

    try {
      const [queryVec] = await this.embedder.embed([query]);
      if (!queryVec) return [];

      // 线性扫 cosine 相似度
      const scored = this.indexVectors.map((vec, i) => ({
        name: this.indexMeta[i]!.name,
        title: this.indexMeta[i]!.title,
        desc: this.indexMeta[i]!.desc,
        score: cosineSimilarity(queryVec, vec),
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    } catch {
      return [];
    }
  }

  /**
   * ToolResolver 接口实现。
   *
   * top-1 相似度 > directHitThreshold → 直接返回（source=embedding，confidence 按相似度）
   * 否则返回 null（交下游 LlmToolResolver 在 top-K 候选里精选）
   */
  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    if (!this.ready) return null;

    // 用 semantic + description 组合作为查询（description 更自然语言，检索质量更好）
    const query = need.description
      ? `${need.semantic} ${need.description}`
      : need.semantic;

    const candidates = await this.retrieve(query, 1);
    if (candidates.length === 0) return null;

    const top = candidates[0]!;
    if (top.score < this.directHitThreshold) return null;

    return {
      toolName: top.name,
      params: {},
      source: "index",  // 复用 index source（高置信度本地命中）
      confidence: Math.min(top.score, 0.95),  // 上限 0.95，不等于 1.0（留给规则索引）
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

  /** 取当前索引的候选数（调试用）。 */
  indexSize(): number {
    return this.indexVectors.length;
  }

  // ── 内部 ──

  /** 把分桶工具拼成可索引文本。 */
  private buildSearchableText(b: BucketItem): string {
    const parts = [b.title, b.desc, ...(b.triggers ?? [])];
    if (b.semanticTags && b.semanticTags.length > 0) {
      parts.push(...b.semanticTags);
    }
    return parts.filter(Boolean).join(" ");
  }

  /** 持久化向量索引。 */
  private persistIndex(): void {
    mkdirSync(this.cacheDir, { recursive: true });
    const dim = this.indexVectors[0]?.length ?? 0;
    // 扁平化向量数组（节省 JSON 体积）
    const flatVectors: number[] = [];
    for (const vec of this.indexVectors) {
      flatVectors.push(...vec);
    }
    const data: VectorIndexFile = {
      serverId: this.cacheDir.split("/").pop() ?? "unknown",
      generatedAt: new Date().toISOString(),
      dimension: dim,
      items: this.indexMeta.map((m, i) => ({
        name: m.name,
        text: this.indexTexts[i] ?? "",
        title: m.title,
        desc: m.desc,
      })),
      vectors: flatVectors,
    };
    writeFileSync(join(this.cacheDir, "vectors.json"), JSON.stringify(data));
  }
}
