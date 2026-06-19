/**
 * ObsidianProvider（C 层 —— 平台通用实现，扫任意 Obsidian vault）。
 *
 * 不依赖向量检索（本次范围排除），用：
 *   - frontmatter 索引（category/tags/title）
 *   - 关键词匹配（TF 粗排，title 加权）
 *
 * Vault 内容结构由应用提供（NexusOps 用精益五类上下文），
 * 本 provider 只负责扫描 + 检索，不知道领域语义。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type {
  IKnowledgeProvider,
  KnowledgeSnippet,
  KnowledgeQuery,
} from "./provider.js";

interface IndexedDoc {
  path: string; // 相对 vault 根的相对路径
  absPath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string; // 去 frontmatter 后的正文
  tags: string[];
}

/** ObsidianProvider 配置。 */
export interface ObsidianProviderOptions {
  /** vault 根目录绝对路径。 */
  vaultPath: string;
  /** provider id（缺省 "obsidian"）。 */
  id?: string;
  /** 扫描的扩展名（缺省 [".md"]）。 */
  extensions?: string[];
}

/**
 * Obsidian vault 知识库 provider。
 */
export class ObsidianProvider implements IKnowledgeProvider {
  readonly id: string;
  readonly description: string;
  private readonly vaultPath: string;
  private readonly extensions: string[];
  private docs: IndexedDoc[] = [];
  private initialized = false;

  constructor(opts: ObsidianProviderOptions) {
    this.id = opts.id ?? "obsidian";
    this.vaultPath = opts.vaultPath;
    this.extensions = opts.extensions ?? [".md"];
    this.description = `Obsidian vault @ ${opts.vaultPath}`;
  }

  ready(): boolean {
    return this.initialized && this.docs.length > 0;
  }

  /** 扫描 vault 索引全部 markdown。幂等。 */
  async init(): Promise<void> {
    if (!existsSync(this.vaultPath)) {
      this.initialized = false;
      return;
    }
    this.docs = await this.scanDir(this.vaultPath);
    this.initialized = true;
  }

  /** 按自然语言 query 检索最相关片段（关键词 TF + title 加权）。 */
  async search(query: KnowledgeQuery): Promise<KnowledgeSnippet[]> {
    if (!this.ready()) await this.init();
    if (!this.ready()) return [];

    const topK = query.topK ?? 5;
    const terms = tokenize(query.query);
    if (terms.length === 0) return [];

    const scored = this.docs
      .map((doc) => {
        const score = this.scoreDoc(doc, terms, query.filter);
        return { doc, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map(({ doc, score }) => this.docToSnippet(doc, score));
  }

  /** 按 path 精确读取整个文档（path 是相对 vault 根的路径）。 */
  async read(path: string): Promise<KnowledgeSnippet | null> {
    if (!this.ready()) await this.init();
    if (!this.ready()) return null;
    const doc =
      this.docs.find((d) => d.path === path) ??
      this.docs.find((d) => d.path.replace(/\.md$/, "") === path.replace(/\.md$/, ""));
    if (!doc) return null;
    return this.docToSnippet(doc, 1);
  }

  /** 列出全部文档路径（相对 vault 根）。 */
  async list(): Promise<string[]> {
    if (!this.ready()) await this.init();
    if (!this.ready()) return [];
    return this.docs.map((d) => d.path);
  }

  // ── 内部 ──

  private async scanDir(dir: string): Promise<IndexedDoc[]> {
    const out: IndexedDoc[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      // 跳过隐藏目录（.obsidian / .trash / .git）
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.scanDir(full);
        out.push(...sub);
      } else if (
        entry.isFile() &&
        this.extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        const doc = await this.indexFile(full);
        if (doc) out.push(doc);
      }
    }
    return out;
  }

  private async indexFile(absPath: string): Promise<IndexedDoc | null> {
    let raw: string;
    try {
      raw = await readFile(absPath, "utf8");
    } catch {
      return null;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const relPath = relative(this.vaultPath, absPath).split(sep).join("/");
    const title =
      (frontmatter.title as string | undefined) ??
      absPath.split(sep).pop()?.replace(/\.md$/, "") ??
      relPath;
    const tags = extractTags(frontmatter, body);
    return {
      path: relPath,
      absPath,
      title,
      frontmatter,
      body,
      tags,
    };
  }

  private scoreDoc(
    doc: IndexedDoc,
    terms: string[],
    filter?: Record<string, string>,
  ): number {
    // frontmatter 过滤
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (String(doc.frontmatter[k] ?? "") !== v) return 0;
      }
    }
    let score = 0;
    const titleLower = doc.title.toLowerCase();
    const bodyLower = doc.body.toLowerCase();
    const tagsLower = doc.tags.map((t) => t.toLowerCase());
    for (const term of terms) {
      const t = term.toLowerCase();
      // title 命中权重最高（3），tags 次之（2），body 命中（1）
      if (titleLower.includes(t)) score += 3;
      if (tagsLower.some((tag) => tag.includes(t))) score += 2;
      const occurrences = countOccurrences(bodyLower, t);
      score += occurrences;
    }
    return score;
  }

  private docToSnippet(doc: IndexedDoc, score: number): KnowledgeSnippet {
    return {
      title: doc.title,
      content: doc.body,
      path: doc.path,
      frontmatter: doc.frontmatter,
      score,
    };
  }
}

/** 解析 markdown frontmatter（YAML 头部）。 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const yaml = match[1] ?? "";
  const body = match[2] ?? raw;
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as string;
    let value: unknown = (m[2] ?? "").trim();
    // 去引号
    if (typeof value === "string" && /^".*"$|^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    // tags: [a, b] 或 tags:\n - a\n - b
    if (key === "tags" && typeof value === "string") {
      if (value.startsWith("[")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/** 从 frontmatter.tags 和正文 #tag 提取标签。 */
function extractTags(
  frontmatter: Record<string, unknown>,
  body: string,
): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string") tags.add(t);
  } else if (typeof fmTags === "string") {
    for (const t of fmTags.split(",")) tags.add(t.trim());
  }
  // 正文行内 #tag
  const inlineMatches = body.matchAll(/(?:^|\s)#([\w\u4e00-\u9fa5-]+)/g);
  for (const m of inlineMatches) tags.add(m[1] as string);
  return [...tags];
}

/** 分词：英文按空格/标点，中文按字符。 */
function tokenize(query: string): string[] {
  return query
    .split(/[\s,，。、；;:：!！?？()（）\[\]【】"]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// 引入 stat 避免 unused（部分 Node 版本需显式导出检测）
void stat;
