import { z } from "zod";
import type { WorkflowDAG, WorkflowNode } from "./dag-schema.js";

/**
 * Podcast MVP 模板（P4：文本子链，双数据路径 + rewrite style 参数化）。
 *
 * 数据源双路径（见计划"关键调整 1"）：
 *   A. 主题检索：web_search(topic) → web_fetch(urls)
 *   B. URL 直抓：web_fetch(urls)
 * 由 planner 从意图抽取（intent 含 URL → 路径 B；否则 → 路径 A）。
 *
 * rewrite 形式参数化（见计划"关键调整 2"）：
 *   params.style ∈ dialogue(对话) / narration(第三方转述) / summary(客观总结)
 *
 * HITL 触发点（见计划 P4 验收）：
 *   - fetch 后：用户选择/筛选抓取内容（requireConfirmation: true）
 *   - rewrite 后：用户预览改写稿再继续（requireConfirmation: true）
 *
 * 注：TTS/生图/视频（step4-6）留到 P5 重 IO Provider，本模板不含。
 */

export type RewriteStyle = "dialogue" | "narration" | "summary";

/** Podcast 模板参数（planner LLM 抽取填充）。 */
export const PodcastParams = z.object({
  /** 数据源路径。 */
  sourceMode: z.enum(["topic", "url"]),
  /** topic 模式下的检索查询词（sourceMode=topic 必填）。 */
  topic: z.string().optional(),
  /** url 模式下的 URL 列表（sourceMode=url 必填）。 */
  urls: z.array(z.string().url()).optional(),
  /** rewrite 形式。 */
  style: z.enum(["dialogue", "narration", "summary"]).default("dialogue"),
  /** 生成语言（如 "zh"、"en"）。 */
  language: z.string().default("zh"),
  /** rewrite 的额外指令（可选，如目标时长、口吻）。 */
  rewriteHint: z.string().optional(),
  /** 检索最大结果数（topic 模式）。 */
  maxSearchResults: z.number().int().positive().max(10).default(5),
});
export type PodcastParams = z.infer<typeof PodcastParams>;

/** 模板路由关键词（见 06 §6.2，podcast 专用规则）。 */
const PODCAST_RULES: Array<[string, RegExp]> = [
  ["podcast", /播客|podcast|做成.*音频|音频.*节目|对谈|访谈/],
];

/** 通用模板路由（覆盖 podcast + 几个兜底，便于 guardrail 判定可服务性）。 */
const GENERAL_RULES: Array<[string, RegExp]> = [
  ["podcast", /播客|podcast|做成.*音频|音频.*节目|对谈|访谈/],
  ["research", /分析|研究|调研|对比|综述|investigate|analyze|research|compare/],
  ["summary", /总结|摘要|概括|提炼|summarize|digest/],
];

/** 路由到模板 id；未命中返回 null。 */
export function routeTemplate(intent: string): string | null {
  for (const [id, pattern] of GENERAL_RULES) {
    if (pattern.test(intent)) return id;
  }
  return null;
}

/** 是否命中 podcast 模板。 */
export function isPodcastIntent(intent: string): boolean {
  return PODCAST_RULES.some(([, pattern]) => pattern.test(intent));
}

/** 从意图粗抽取 URL（用于 sourceMode=url 判定）。 */
export function extractUrls(intent: string): string[] {
  const re = /https?:\/\/[^\s，。、）)」"']+/gi;
  return intent.match(re) ?? [];
}

/**
 * 用抽取好的 PodcastParams 构建 podcast 文本子链 DAG。
 * 节点 id 稳定，供 inputRefs 引用。
 */
export function buildPodcastDag(params: PodcastParams): WorkflowDAG {
  const nodes: WorkflowNode[] = [];
  const confirmed = { maxTokens: 4000, strip: true, summarize: false };

  // 数据源节点（双路径二选一）
  let firstNodeId: string;
  if (params.sourceMode === "url") {
    const urls = params.urls ?? [];
    firstNodeId = "fetch";
    nodes.push({
      id: "fetch",
      toolName: "core.web_fetch",
      params: { urls, maxBytes: 1_000_000 },
      inputRefs: {},
      dependsOn: [],
      requireConfirmation: true, // HITL: 选择/筛选抓取内容
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
  } else {
    // topic 模式：search → fetch
    firstNodeId = "fetch";
    nodes.push({
      id: "search",
      toolName: "core.web_search",
      params: { query: params.topic ?? "", maxResults: params.maxSearchResults },
      inputRefs: {},
      dependsOn: [],
      requireConfirmation: false,
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
    // fetch 从 search 结果取 url 注入（inputRefs → web_fetch 的 fromInputRefs）
    nodes.push({
      id: "fetch",
      toolName: "core.web_fetch",
      params: {},
      // $.tasks.search.output 是 SearchResult[]，web_fetch 期望 fromInputRefs: {url,title}[]
      inputRefs: { "$.tasks.search.output": "fromInputRefs" },
      dependsOn: ["search"],
      requireConfirmation: true, // HITL: 选择/筛选抓取内容
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
  }

  // rewrite 节点：消费 fetch 正文，按 style 改写
  nodes.push({
    id: "rewrite",
    toolName: "core.llm_node",
    params: {
      prompt: params.rewriteHint
        ? `请把素材改写成播客文稿。要求：${params.rewriteHint}`
        : "请把素材改写成播客文稿。",
      style: params.style,
      role: "writer",
      systemPrompt: `目标语言：${params.language}。输出一段完整的播客文稿。`,
    },
    // fetch 输出是 FetchedDoc[]，取第一篇正文（contentPipeline 已压缩）
    inputRefs: { "$.tasks.fetch.output[0].content": "context" },
    dependsOn: [firstNodeId],
    requireConfirmation: true, // HITL: 预览改写稿再继续
    onNodeError: "abort",
    contentPipeline: { maxTokens: 6000, strip: true, summarize: false },
  });

  // deliver 节点：聚合 rewrite 输出为最终产物（rewrite 输出单字符串，deliver 归一为单元素数组）
  nodes.push({
    id: "deliver",
    toolName: "core.deliver",
    params: { artifactType: "podcast_script", title: `podcast-${params.style}` },
    inputRefs: { "$.tasks.rewrite.output": "items" },
    dependsOn: ["rewrite"],
    requireConfirmation: false,
    onNodeError: "abort",
    contentPipeline: confirmed,
  });

  return {
    schemaVersion: "1.0",
    nodes,
    onNodeError: "abort",
    retryAttempts: 0,
  };
}

/** 模板骨架（供 planner LLM 上下文 + guardrail）。 */
export interface TemplateSkeleton {
  templateId: string;
  description: string;
}

export const TEMPLATES: Record<string, TemplateSkeleton> = {
  podcast: {
    templateId: "podcast",
    description: "播客文稿生成：[topic: web_search→web_fetch | url: web_fetch] → rewrite(style) → deliver",
  },
  research: {
    templateId: "research",
    description: "研究分析：web_search → web_fetch → llm整合 → deliver",
  },
  summary: {
    templateId: "summary",
    description: "内容摘要：web_fetch → llm总结 → deliver",
  },
};
