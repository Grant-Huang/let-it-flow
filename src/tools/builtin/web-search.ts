import { z } from "zod";
import type { FlowConnector, ToolResult, ExecutionContext } from "../base.js";
import { RUNTIME, SERVICE_URLS } from "../../core/config.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { randomUUID } from "node:crypto";
import { getSearchMaxResults } from "../../core/system-settings.js";
import { narrate } from "../../core/narrate.js";

/**
 * web_search —— 网络检索（见 04 §4.4 内置工具，podcast MVP 数据源双路径之一）。
 *
 * Provider 抽象：MVP 支持 tavily（需 key）/ native（无 key，质量低）。
 * 由环境变量 LIF_SEARCH_PROVIDER 或调用方 params.provider 决定。
 *
 * 输出：SearchResult[]（title/url/snippet），供下游 web_fetch 抓取正文。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, opts: { maxResults: number }): Promise<SearchResult[]>;
}

/** Tavily provider（需 TAVILY_API_KEY）。 */
export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    name: "tavily",
    async search(query, opts) {
      const res = await fetch(SERVICE_URLS.tavilySearch, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: opts.maxResults,
          search_depth: "basic",
        }),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));
    },
  };
}

/**
 * Native provider：用 DuckDuckGo HTML（无 key）做最小可用检索。
 * 质量低、易被限流，仅作无 key 兜底；生产建议配 Tavily。
 */
export function createNativeProvider(): SearchProvider {
  return {
    name: "native",
    async search(query, opts) {
      const url = `${SERVICE_URLS.duckduckgoHtml}?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (let-it-flow/0.1)" },
      });
      if (!res.ok) throw new Error(`ddg ${res.status}`);
      const html = await res.text();
      return parseDdgHtml(html).slice(0, opts.maxResults);
    },
  };
}

// 从 DuckDuckGo HTML 粗解析结果（result__a 链接 + snippet）
function parseDdgHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|span)>/g;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    links.push({ url: decodeDdgRedirect(m[1] ?? ""), title: stripTags(m[2] ?? "") });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html))) {
    snippets.push(stripTags(m[1] ?? ""));
  }
  for (let i = 0; i < links.length; i++) {
    out.push({ ...links[i]!, snippet: snippets[i] ?? "" });
  }
  return out;
}

function decodeDdgRedirect(href: string): string {
  // DDG 链接形如 //duckduckgo.com/l/?uddg=<encoded>
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1] ?? "");
    } catch {
      return href;
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
}

const inputSchema = z.object({
  query: z.string().min(1).describe("检索查询词"),
  maxResults: z.number().int().positive().max(20).default(() => getSearchMaxResults()).describe("最大结果数"),
  provider: z.enum(["tavily", "native"]).optional().describe("指定 provider；缺省读环境变量"),
});

export interface WebSearchToolOptions {
  /** 注入自定义 provider（测试用）。 */
  provider?: SearchProvider;
}

export function createWebSearchTool(opts: WebSearchToolOptions = {}): FlowConnector<SearchResult[]> {
  return {
    name: "core.web_search",
    tier: "core",
    description: "网络检索：根据查询词返回搜索结果（title/url/snippet），供 web_fetch 抓取正文。",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["最新新闻", "财报", "股票", "行情", "实时客观事实", "未知事实", "需要查资料", "主题检索"],
      notFor: ["已有 URL 的网页（走 web_fetch）", "本地笔记（走 knowledge_base）", "需要生成文本（走 llm_node）"],
    },
    outputSchema: {
      type: "object",
      description: "搜索结果（数组），供 web_fetch 节点引用其 url 字段",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "页面标题" },
              url: { type: "string", description: "结果页 URL" },
              snippet: { type: "string", description: "内容摘要" },
            },
          },
        },
      },
    },
    outputExample: {
      results: [{ title: "Q1 财报", url: "https://example.com/report", snippet: "营收同比增长..." }],
    },

    async *execute(params, ctx: ExecutionContext): AsyncGenerator<ToolEvent, ToolResult<SearchResult[]>> {
      const args = inputSchema.parse(params);
      const provider = opts.provider ?? resolveProvider(args.provider);
      // 复用编排层注入的 callId（ReAct 模式），保证事件一致；DAG 模式自行生成
      const callId = ctx.callId ?? `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "core.web_search",
          args: { query: args.query, maxResults: args.maxResults },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "search",
        }),
      };
      const t0 = Date.now();
      let results: SearchResult[];
      let errMsg: string | undefined;
      await narrate(ctx, `正在检索：${args.query}…`);
      try {
        results = await provider.search(args.query, { maxResults: args.maxResults });
      } catch (e) {
        results = [];
        errMsg = e instanceof Error ? e.message : String(e);
      }
      if (!errMsg) {
        await narrate(ctx, `找到 ${results.length} 条结果。`);
      } else {
        await narrate(ctx, `检索失败：${errMsg}。`);
      }
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(results),
          error: errMsg,
          duration_ms: Date.now() - t0,
        }),
      };
      if (errMsg) throw new Error(`web_search failed: ${errMsg}`);
      return {
        output: results,
        summary: `${results.length} results for "${args.query}"`,
        narration: `检索完成：找到 ${results.length} 条关于"${args.query}"的结果`,
      };
    },
  };
}

function resolveProvider(pref?: "tavily" | "native"): SearchProvider {
  // 优先级：显式 pref > LIF_SEARCH_PROVIDER > 有 key 用 tavily
  const cfg = RUNTIME.searchProvider;
  const chosen = pref
    ?? (cfg === "native" ? "native"
      : cfg === "tavily" ? "tavily"
      : (RUNTIME.tavilyApiKey ? "tavily" : "native"));
  if (chosen === "tavily") {
    if (!RUNTIME.tavilyApiKey) throw new Error("TAVILY_API_KEY not set; set it or use provider=native");
    return createTavilyProvider(RUNTIME.tavilyApiKey);
  }
  return createNativeProvider();
}
