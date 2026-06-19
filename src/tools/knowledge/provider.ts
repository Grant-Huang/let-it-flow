/**
 * IKnowledgeProvider 接口（C 层框架 —— 平台定义接口，应用提供实现）。
 *
 * 知识库的统一抽象：所有 KB 形态（Obsidian vault、向量库、企业 Wiki、MCP 资源）
 * 实现此接口后，可被 harness 的 core.knowledge_base 工具统一调用。
 *
 * 平台只定义接口 + ObsidianProvider/MCP provider 两个通用实现；
 * 应用挂载具体 vault 路径 / MCP server。
 */
import type { EvidenceEnvelope } from "../../core/evidence-envelope.js";

/** 单条知识检索结果（一个文档片段 + 元数据）。 */
export interface KnowledgeSnippet {
  /** 文档标题或标识。 */
  title: string;
  /** 内容片段（markdown 纯文本）。 */
  content: string;
  /** 文档在 KB 中的路径 / URI（用于 provenance）。 */
  path: string;
  /** 文档 frontmatter（如有，含分类、标签、版本等）。 */
  frontmatter?: Record<string, unknown>;
  /** 检索相关性评分（0-1，由 provider 计算；关键词匹配或向量相似度）。 */
  score?: number;
}

/** 检索请求参数。 */
export interface KnowledgeQuery {
  /** 自然语言查询。 */
  query: string;
  /** 返回结果数上限（缺省 5）。 */
  topK?: number;
  /** 按 frontmatter 字段过滤（如 { category: "03-精益知识" }）。 */
  filter?: Record<string, string>;
}

/**
 * 知识库 provider 接口。
 *
 * 实现者负责：
 *   - 初始化（扫描 vault / 连接 MCP / 建 embedding 索引）
 *   - search：按 query 检索最相关的 N 个片段
 *   - read：按 path 精确读取整个文档
 */
export interface IKnowledgeProvider {
  /** provider 唯一标识（如 "obsidian" / "mcp:wiki"）。 */
  readonly id: string;
  /** 人类可读描述（用于日志）。 */
  readonly description: string;
  /** 是否已就绪（初始化完成、可用）。 */
  ready(): boolean;
  /** 按自然语言 query 检索片段。 */
  search(query: KnowledgeQuery): Promise<KnowledgeSnippet[]>;
  /** 按 path 精确读取整个文档。 */
  read(path: string): Promise<KnowledgeSnippet | null>;
  /** 列出 KB 中所有文档路径（可选，用于探索）。 */
  list?(): Promise<string[]>;
}

/**
 * 把 KnowledgeSnippet 包装成 EvidenceEnvelope（KB 类证据统一信封）。
 * KB 内容 confidence=inferred（不是实测数据），freshness 由调用者指定。
 */
export function wrapSnippetAsEvidence(
  snippet: KnowledgeSnippet,
  opts: { freshness?: EvidenceEnvelope["freshness"]; system?: string } = {},
): EvidenceEnvelope<KnowledgeSnippet> {
  return {
    data: snippet,
    freshness: opts.freshness ?? "historical",
    capturedAt: new Date().toISOString(),
    confidence: "inferred",
    source: {
      system: opts.system ?? "obsidian",
      provenance: snippet.path,
    },
    ...(snippet.frontmatter?.version
      ? { caveat: `文档版本：${snippet.frontmatter.version}` }
      : {}),
  };
}
