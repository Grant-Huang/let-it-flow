/**
 * 加拿大橱柜报价公司线索抓取管线。
 *
 * search（多查询变体覆盖主要城市/省份）→ fetch（复用平台 extractHtml 正文提取）
 * → LLM 结构化抽取（公司名/联系人/邮箱/电话）。
 *
 * 不复用 core.web_search / core.web_fetch 的 FlowConnector 包装（那层是为 DAG
 * 执行器的事件流设计的，需要 ExecutionContext）；直接调用底层 SearchProvider +
 * 平台导出的 extractHtml，保持这个独立 example 脚本简单可测。
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  createTavilyProvider,
  createNativeProvider,
  extractHtml,
  type SearchProvider,
  type SearchResult,
} from "../../src/tools/index.js";
import type { LlmService } from "../../src/services/llm-service.js";
import type { Lead } from "./types.js";

const DEFAULT_CITIES = [
  "Toronto",
  "Vancouver",
  "Calgary",
  "Ottawa",
  "Montreal",
  "Edmonton",
  "Mississauga",
  "Winnipeg",
];

const MAX_RESULTS_PER_QUERY = 8;
const MAX_FETCH_BYTES = 800_000;
const FETCH_TIMEOUT_MS = 15_000;

/** 生成检索查询词变体：通用词 + 逐城市细化，覆盖英语（+ 魁北克法语）。 */
export function buildSearchQueries(cities: string[] = DEFAULT_CITIES): string[] {
  const queries = [
    "custom kitchen cabinets Canada request a quote contact email",
    "kitchen cabinet manufacturer Canada RFQ contact us email",
    "armoires de cuisine sur mesure devis Québec courriel contact",
  ];
  for (const city of cities) {
    queries.push(`kitchen cabinets quote ${city} Canada contact email`);
  }
  return queries;
}

function resolveSearchProvider(): SearchProvider {
  const apiKey = process.env.TAVILY_API_KEY;
  return apiKey ? createTavilyProvider(apiKey) : createNativeProvider();
}

/** mailto: 链接正则抽取（原始 HTML，抓取正文前）——比 LLM 抽取更可靠。 */
function extractMailtoEmails(html: string): string[] {
  const out = new Set<string>();
  const re = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.add((m[1] ?? "").toLowerCase());
  }
  return [...out];
}

const JUNK_EMAIL_PATTERNS = [
  /^(no-?reply|donotreply|noreply)@/i,
  /^(webmaster|postmaster|abuse|privacy|unsubscribe)@/i,
  /@(sentry\.io|wixpress\.com|godaddy\.com|example\.com|schema\.org)$/i,
];

function isJunkEmail(email: string): boolean {
  return JUNK_EMAIL_PATTERNS.some((re) => re.test(email));
}

interface FetchedPage {
  url: string;
  title: string;
  content: string;
  mailtoEmails: string[];
  error?: string;
}

async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; let-it-flow-cabinet-scraper/0.1)" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { url, title: url, content: "", mailtoEmails: [], error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, MAX_FETCH_BYTES));
    if (!ctype.includes("text/html")) return { url, title: url, content: raw, mailtoEmails: [] };
    const { title, content } = extractHtml(raw);
    const mailtoEmails = extractMailtoEmails(raw).filter((e) => !isJunkEmail(e));
    return { url, title: title || url, content, mailtoEmails };
  } catch (e) {
    return { url, title: url, content: "", mailtoEmails: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const ExtractedLeadSchema = z.object({
  companyName: z.string().min(1),
  contactName: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
});
const ExtractionResultSchema = z.object({ leads: z.array(ExtractedLeadSchema).max(5) });

async function extractLeadsFromPage(
  page: FetchedPage,
  llm: LlmService,
): Promise<Omit<Lead, "id" | "sourceUrl" | "foundAt">[]> {
  if (!page.content && page.mailtoEmails.length === 0) return [];

  const model = llm.model("summarizer");
  const foldSystem = llm.compatMode;
  const system = [
    "你是一个 B2B 线索抽取器。从网页正文中识别「加拿大橱柜（kitchen cabinet）供应商/制造商/经销商」的公司信息。",
    "只抽取该公司自己的业务联系邮箱（销售/报价/客服），不要抽取第三方、隐私政策、社媒插件等无关邮箱。",
    "如果页面明显不是橱柜/厨柜相关企业，返回空数组。",
    "email 字段必须是合法邮箱格式；找不到邮箱的候选公司不要输出。",
  ].join("\n");
  const mailtoHint = page.mailtoEmails.length
    ? `\n\n页面中已提取到的 mailto 邮箱（优先使用，若能匹配到公司信息）：${page.mailtoEmails.join(", ")}`
    : "";
  const user = `网页标题：${page.title}\n网页 URL：${page.url}${mailtoHint}\n\n正文（截断）：\n${page.content.slice(0, 6000)}`;

  const callArgs = foldSystem
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
    : { system, messages: [{ role: "user" as const, content: user }] };

  try {
    const { output } = await generateText({
      model,
      ...callArgs,
      output: Output.object({ schema: ExtractionResultSchema }),
      temperature: 0,
    });
    if (!output) return [];
    return output.leads
      .filter((l) => !isJunkEmail(l.email))
      .map((l) => ({ ...l, website: new URL(page.url).origin }));
  } catch {
    // LLM 抽取失败时，退化为仅用 mailto 正则结果（无法得知公司名，跳过——宁可漏抓不误报）。
    return [];
  }
}

export interface SearchLeadsOptions {
  cities?: string[];
  maxQueries?: number;
  onProgress?: (message: string) => void;
}

/** 完整管线：检索 → 去重 URL → 抓取 → LLM 抽取 → 按邮箱去重。 */
export async function searchCabinetLeads(
  llm: LlmService,
  opts: SearchLeadsOptions = {},
): Promise<Lead[]> {
  const provider = resolveSearchProvider();
  const queries = buildSearchQueries(opts.cities).slice(0, opts.maxQueries ?? 6);
  const notify = opts.onProgress ?? (() => {});

  const seenUrls = new Set<string>();
  const results: SearchResult[] = [];
  for (const q of queries) {
    notify(`检索：${q}`);
    try {
      const r = await provider.search(q, { maxResults: MAX_RESULTS_PER_QUERY });
      for (const item of r) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          results.push(item);
        }
      }
    } catch (e) {
      notify(`检索失败（${q}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  notify(`共 ${results.length} 个候选网页，开始抓取…`);
  const leadsByEmail = new Map<string, Lead>();
  let idx = 0;
  for (const r of results) {
    idx++;
    notify(`抓取 [${idx}/${results.length}] ${r.url}`);
    const page = await fetchPage(r.url);
    if (page.error) continue;
    const extracted = await extractLeadsFromPage(page, llm);
    for (const lead of extracted) {
      const key = lead.email.toLowerCase();
      if (leadsByEmail.has(key)) continue;
      leadsByEmail.set(key, {
        id: `lead_${key.replace(/[^a-z0-9]/g, "_")}`,
        sourceUrl: r.url,
        foundAt: new Date().toISOString(),
        ...lead,
      });
    }
  }

  notify(`抽取完成：共 ${leadsByEmail.size} 条线索（去重后）。`);
  return [...leadsByEmail.values()];
}
