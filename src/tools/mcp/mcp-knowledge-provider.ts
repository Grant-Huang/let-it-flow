/**
 * MCP → IKnowledgeProvider 适配（C 层）。
 *
 * MCP server 的 resources 接口提供只读数据（KB 语义），
 * 本适配器把它包成 IKnowledgeProvider，让 core.knowledge_base 工具统一调用。
 */
import type {
  IKnowledgeProvider,
  KnowledgeSnippet,
  KnowledgeQuery,
} from "../knowledge/provider.js";
import type { McpClient } from "./mcp-client.js";

/** MCP provider 配置。 */
export interface McpKnowledgeProviderOptions {
  /** provider id（缺省 "mcp:<serverId>"）。 */
  id?: string;
  /** server id（用于日志 + provenance）。 */
  serverId: string;
  /** 已连接的 MCP 客户端。 */
  client: McpClient;
}

/**
 * 把 MCP server 的 resources 接口适配成 IKnowledgeProvider。
 * search 通过 listResources + 关键词匹配实现（无向量）。
 */
export class McpKnowledgeProvider implements IKnowledgeProvider {
  readonly id: string;
  readonly description: string;
  private readonly client: McpClient;
  private cachedResources: Awaited<ReturnType<McpClient["listResources"]>> | null = null;

  constructor(opts: McpKnowledgeProviderOptions) {
    this.id = opts.id ?? `mcp:${opts.serverId}`;
    this.client = opts.client;
    this.description = `MCP knowledge provider @ ${opts.serverId}`;
  }

  ready(): boolean {
    return true; // MCP client 自己管连接状态
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeSnippet[]> {
    const topK = query.topK ?? 5;
    const terms = query.query
      .toLowerCase()
      .split(/[\s,，。、]+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return [];

    let resources: Awaited<ReturnType<McpClient["listResources"]>>;
    try {
      resources = await this.client.listResources();
    } catch {
      return [];
    }
    this.cachedResources = resources;

    const scored = resources
      .map((res) => {
        const haystack = `${res.name ?? ""} ${res.description ?? ""} ${res.uri}`.toLowerCase();
        const score = terms.reduce((sum, t) => (haystack.includes(t) ? sum + 1 : sum), 0);
        return { res, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const out: KnowledgeSnippet[] = [];
    for (const { res, score } of scored) {
      let content = "";
      try {
        const r = await this.client.readResource(res.uri);
        content = r.contents.map((c) => c.text ?? "").join("\n");
      } catch {
        content = "";
      }
      out.push({
        title: res.name ?? res.uri,
        content,
        path: res.uri,
        score,
      });
    }
    return out;
  }

  async read(path: string): Promise<KnowledgeSnippet | null> {
    try {
      const r = await this.client.readResource(path);
      const content = r.contents.map((c) => c.text ?? "").join("\n");
      return {
        title: path,
        content,
        path,
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    if (!this.cachedResources) {
      try {
        this.cachedResources = await this.client.listResources();
      } catch {
        return [];
      }
    }
    return this.cachedResources.map((r) => r.uri);
  }
}
