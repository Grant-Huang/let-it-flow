import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FlowConnector, ToolResult } from "../base.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { ToolEvent } from "../../core/stream-events.js";

/**
 * web_fetch —— 网页抓取（见 04 §4.4，podcast MVP 数据源双路径之二）。
 *
 * 接收一组 URL（或经 inputRefs 从上游 web_search 结果取 url），fetch 后做
 * 正文提取（HTML → 纯文本/markdown，剥离导航/脚本/样式）。
 *
 * 输出：FetchedDoc[]（url/title/content）。content 是粗提取的正文；
 * 下游 LLM 节点会经 executor 的 Content Pipeline（strip + truncate）再压缩，
 * 这里不做截断/摘要（职责分离）。
 */

export interface FetchedDoc {
  url: string;
  title: string;
  content: string;
  /** 抓取失败的错误信息（成功则缺省）。 */
  error?: string;
}

const inputSchema = z.object({
  urls: z.array(z.string().url()).min(1).describe("要抓取的 URL 列表"),
  /** 当通过 inputRefs 引用上游 web_search 结果时，executor 解析后注入此处。 */
  fromInputRefs: z
    .array(z.object({ url: z.string(), title: z.string().optional() }))
    .optional()
    .describe("由 executor 从 inputRefs 解析注入；优先于 urls"),
  /** 单页最大抓取字节数（兜底，避免超大页撑爆内存）。默认 1MB。 */
  maxBytes: z.number().int().positive().default(1_000_000),
});

export function createWebFetchTool(): FlowConnector<FetchedDoc[]> {
  return {
    name: "core.web_fetch",
    tier: "core",
    description: "网页抓取：fetch URL 列表，提取正文为纯文本/markdown。content 由下游 Content Pipeline 再压缩。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<FetchedDoc[]>> {
      const args = inputSchema.parse(params);
      const targets: Array<{ url: string; title?: string }> =
        args.fromInputRefs && args.fromInputRefs.length > 0 ? args.fromInputRefs : args.urls.map((url) => ({ url }));

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "core.web_fetch",
          args: { urlCount: targets.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "fetch",
        }),
      };

      const t0 = Date.now();
      const docs: FetchedDoc[] = [];
      for (const t of targets) {
        const doc = await fetchOne(t.url, args.maxBytes);
        docs.push({ ...doc, title: t.title ?? doc.title });
      }
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(docs),
          duration_ms: Date.now() - t0,
        }),
      };
      return {
        output: docs,
        summary: `${docs.filter((d) => !d.error).length}/${docs.length} fetched`,
      };
    },
  };
}

async function fetchOne(url: string, maxBytes: number): Promise<FetchedDoc> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; let-it-flow/0.1)" },
      redirect: "follow",
    });
    if (!res.ok) {
      return { url, title: url, content: "", error: `HTTP ${res.status}` };
    }
    const ctype = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, maxBytes));
    if (ctype.includes("text/html")) {
      const { title, content } = extractHtml(raw);
      return { url, title: title || url, content };
    }
    // 非 HTML（text/markdown/json/plain）直接当正文
    return { url, title: url, content: raw };
  } catch (e) {
    return { url, title: url, content: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 最小 HTML 正文提取：去 script/style/nav，保留标题、段落、列表文本。
 * 不引入 cheerio/jsdom 等重依赖（见"优先标准库"）。Content Pipeline 的 strip
 * 会做二次净化，这里只做粗提取。
 */
export function extractHtml(html: string): { title: string; content: string } {
  let title = "";
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) title = stripTags(titleM[1] ?? "").trim();

  // 移除不需要的块
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // 取 <main> 或 <article> 或整个 body
  const mainM = body.match(/<(?:main|article)[\s\S]*?>([\s\S]*?)<\/(?:main|article)>/i);
  const inner = mainM ? (mainM[1] ?? body) : body;

  // 块级标签转换行，去标签
  const text = inner
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, content: text };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}
