/**
 * Podcast 消费应用模板（从 src/planner/templates.ts 迁移）。
 *
 * 实现 ConsumerTemplate 接口，供 podcast-generator 消费应用注入到 LetItFlow。
 * 平台内核不内置此模板。
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import type { WorkflowDAG, WorkflowNode } from "../../src/planner/dag-schema.js";
import type { ConsumerTemplate } from "../../src/planner/consumer-template.js";
import type { LlmService } from "../../src/services/llm-service.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { extractUrls } from "../../src/planner/templates.js";

/**
 * 改进 #2：从 3 种叙事结构扩展到 5 种。
 *   - dialogue/narration/summary：原有三种
 *   - briefing：简报体（多热点 + 深度解读）
 *   - dual_line：双线对照体（两个观点/路径对比）
 */
export type RewriteStyle = "dialogue" | "narration" | "summary" | "briefing" | "dual_line";

/** Podcast 模板参数（planner LLM 抽取填充）。 */
export const PodcastParams = z.object({
  sourceMode: z.enum(["topic", "url"]),
  topic: z.string().optional(),
  urls: z.array(z.string().url()).optional(),
  style: z.enum(["dialogue", "narration", "summary", "briefing", "dual_line"]).default("dialogue"),
  language: z.string().default("zh"),
  rewriteHint: z.string().optional(),
  maxSearchResults: z.number().int().positive().max(10).default(5),
  // 改进 #3：参数化字数公式（字数 = targetMinutes × 210）
  targetMinutes: z.number().int().min(5).max(90).default(30).describe("目标播客时长（分钟）"),
  // 改进 #1：用户可指定线索聚焦提示
  focusHint: z.string().optional().describe("聚焦线索的提示词（多文档时优先采用）"),
  // 改进 #6：是否额外生成公众号文章
  emitWechatArticle: z.boolean().default(false).describe("是否额外输出公众号长文"),
  // 改进 #4：单句长度铁律开关（opt-in：需注册 domain.sentence_validator）
  enableSentenceValidator: z.boolean().default(false).describe("是否启用单句长度校验（≤25字）"),
  // 改进 #1：是否启用线索聚焦节点（opt-in：需注册 domain.thread_focuser）
  enableThreadFocuser: z.boolean().default(false).describe("是否启用多线索聚焦"),
  // 改进 #5：是否启用 KB 检索（opt-in：需注册 core.knowledge_base）
  enableKbLookup: z.boolean().default(false).describe("是否启用知识库检索注入写稿铁律"),
});
export type PodcastParams = z.infer<typeof PodcastParams>;

/** 改进 #3：字数公式 — 字数 = 分钟 × 210，±5% 容差。 */
export function computeTargetWords(minutes: number): { target: number; tolerance: number; min: number; max: number } {
  const target = minutes * 210;
  const tolerance = Math.round(target * 0.05);
  return { target, tolerance, min: target - tolerance, max: target + tolerance };
}

/** Podcast 路由关键词。 */
const PODCAST_PATTERN = /播客|podcast|做成.*音频|音频.*节目|对谈|访谈/;

/**
 * 用抽取好的 PodcastParams 构建 podcast DAG。节点 id 稳定，供 inputRefs 引用。
 *
 * @param params        规划参数
 * @param fullPipeline  true → 完整 7 步链（含 TTS/生图/视频）；
 *                      false → 仅文本子链（fetch→rewrite→deliver）。
 */
export function buildPodcastDag(params: PodcastParams, fullPipeline = false): WorkflowDAG {
  const nodes: WorkflowNode[] = [];
  const confirmed = { maxTokens: 4000, strip: true, summarize: false };

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
      requireConfirmation: true,
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
  } else {
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
    nodes.push({
      id: "fetch",
      toolName: "core.web_fetch",
      params: {},
      inputRefs: { "$.tasks.search.output": "fromInputRefs" },
      dependsOn: ["search"],
      requireConfirmation: true,
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
  }

  if (!fullPipeline) {
    // 改进 #3：根据 targetMinutes 计算字数公式
    const wordPlan = computeTargetWords(params.targetMinutes);

    // 改进 #1：插入 thread_focuser 节点（在 fetch 与 rewrite 之间）
    let upstreamForRewrite: string = firstNodeId;
    let sourceRef: string = "$.tasks.fetch.output[0].content";
    if (params.enableThreadFocuser) {
      nodes.push({
        id: "thread_focuser",
        toolName: "domain.thread_focuser",
        params: {
          focusHint: params.focusHint,
          durationMinutes: params.targetMinutes,
        },
        inputRefs: { "$.tasks.fetch.output": "sourceBundle" },
        dependsOn: [firstNodeId],
        requireConfirmation: false,
        onNodeError: "skip",
        contentPipeline: confirmed,
      });
      upstreamForRewrite = "thread_focuser";
      sourceRef = "$.tasks.thread_focuser.output.selected.content";
    }

    // 改进 #5：可选插入 KB 检索节点（查询写稿铁律 + 叙事结构）
    const rewriteInputRefs: Record<string, string> = { [sourceRef]: "context" };
    const rewriteDeps: string[] = [upstreamForRewrite];
    if (params.enableKbLookup) {
      nodes.push({
        id: "kb_lookup_writing_rules",
        toolName: "core.knowledge_base",
        params: { query: `写稿铁律 ${styleNameZh(params.style)} 单句长度 字数公式` },
        inputRefs: {},
        dependsOn: [],
        requireConfirmation: false,
        onNodeError: "skip",
        contentPipeline: confirmed,
      });
      rewriteInputRefs["$.tasks.kb_lookup_writing_rules.output"] = "writingRules";
      rewriteDeps.push("kb_lookup_writing_rules");
    }

    // 改进 #2/#3/#5：rewrite 节点融合多项改进
    nodes.push({
      id: "rewrite",
      toolName: "core.llm_node",
      params: {
        prompt: params.rewriteHint
          ? `请把素材改写成播客文稿。要求：${params.rewriteHint}`
          : "请把素材改写成播客文稿。",
        style: params.style,
        role: "writer",
        systemPrompt: buildRewriteSystemPrompt(params, wordPlan),
      },
      inputRefs: rewriteInputRefs,
      dependsOn: rewriteDeps,
      requireConfirmation: true,
      onNodeError: "abort",
      contentPipeline: { maxTokens: Math.ceil((wordPlan.max) / 3), strip: true, summarize: false },
    });

    // 改进 #4：句长校验（默认开启，可关闭）
    let lastScriptNode: string = "rewrite";
    let lastScriptRef: string = "$.tasks.rewrite.output";
    if (params.enableSentenceValidator) {
      nodes.push({
        id: "sentence_validator",
        toolName: "domain.sentence_validator",
        params: { maxSentenceLength: 25 },
        inputRefs: { "$.tasks.rewrite.output": "script" },
        dependsOn: ["rewrite"],
        requireConfirmation: false,
        onNodeError: "skip",
        contentPipeline: confirmed,
      });
      lastScriptNode = "sentence_validator";
      lastScriptRef = "$.tasks.sentence_validator.output.script";
    }

    // 改进 #6：可选生成公众号文章（基于已生成的口播稿 + 聚焦理由）
    let deliverDeps: string[] = [lastScriptNode];
    if (params.emitWechatArticle) {
      nodes.push({
        id: "write_wechat_article",
        toolName: "domain.write_wechat_article",
        params: {
          targetWords: Math.round(params.targetMinutes * 1200),
          language: params.language,
        },
        inputRefs: {
          [lastScriptRef]: "podcastScript",
          ...(params.enableThreadFocuser ? { "$.tasks.thread_focuser.output.rationale": "focusedThread" } : {}),
        },
        dependsOn: [lastScriptNode, ...(params.enableThreadFocuser ? ["thread_focuser"] : [])],
        requireConfirmation: false,
        onNodeError: "skip",
        contentPipeline: confirmed,
      });
      deliverDeps = [lastScriptNode, "write_wechat_article"];
    }

    // 改进 #7：deliver 节点强制依赖链上所有产物（precondition 等价）
    nodes.push({
      id: "deliver",
      toolName: "core.deliver",
      params: {
        artifactType: params.emitWechatArticle ? "podcast_with_article" : "podcast_script",
        title: `podcast-${params.style}`,
      },
      inputRefs: {
        [lastScriptRef]: "script",
        ...(params.emitWechatArticle ? { "$.tasks.write_wechat_article.output.article": "article" } : {}),
      },
      dependsOn: deliverDeps,
      requireConfirmation: false,
      onNodeError: "abort",
      contentPipeline: confirmed,
    });
    return { schemaVersion: "1.0", nodes, onNodeError: "abort", retryAttempts: 0 };
  }

  // 完整 7 步链
  nodes.push({
    id: "translate",
    toolName: "domain.translate",
    params: {},
    inputRefs: { "$.tasks.fetch.output[0].content": "sourceText" },
    dependsOn: [firstNodeId],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "rewrite",
    toolName: "domain.rewrite",
    params: { style: params.style, language: params.language, hint: params.rewriteHint },
    inputRefs: { "$.tasks.translate.output.text": "translatedText" },
    dependsOn: ["translate"],
    requireConfirmation: true,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "seam_repair",
    toolName: "domain.seam_repair",
    params: {},
    inputRefs: { "$.tasks.rewrite.output.script": "rewriteText" },
    dependsOn: ["rewrite"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "terminology",
    toolName: "domain.terminology",
    params: {},
    inputRefs: { "$.tasks.seam_repair.output.text": "seamedText" },
    dependsOn: ["seam_repair"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "image_prompts",
    toolName: "domain.image_prompts",
    params: {},
    inputRefs: { "$.tasks.terminology.output.text": "scriptText" },
    dependsOn: ["terminology"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "tts",
    toolName: "domain.tts",
    params: {},
    inputRefs: { "$.tasks.terminology.output.text": "script" },
    dependsOn: ["terminology"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "image_gen",
    toolName: "domain.image_gen",
    params: {},
    inputRefs: { "$.tasks.image_prompts.output.plan": "imagePlan" },
    dependsOn: ["image_prompts"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "subtitle",
    toolName: "domain.subtitle",
    params: {},
    inputRefs: { "$.tasks.tts.output.audioPath": "audioPath" },
    dependsOn: ["tts"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "video_build",
    toolName: "domain.video_build",
    params: {},
    inputRefs: {
      "$.tasks.tts.output.audioPath": "audioPath",
      "$.tasks.image_gen.output.count": "imageCount",
    },
    dependsOn: ["tts", "image_gen", "subtitle"],
    requireConfirmation: false,
    onNodeError: "skip",
    contentPipeline: confirmed,
  });
  nodes.push({
    id: "deliver",
    toolName: "core.deliver",
    params: { artifactType: "podcast_video", title: `podcast-${params.style}` },
    inputRefs: { "$.tasks.video_build.output.videoPath": "items" },
    dependsOn: ["video_build"],
    requireConfirmation: false,
    onNodeError: "abort",
    contentPipeline: confirmed,
  });

  return { schemaVersion: "1.0", nodes, onNodeError: "skip", retryAttempts: 0 };
}

/** 是否命中 podcast 模板。 */
export function isPodcastIntent(intent: string): boolean {
  return PODCAST_PATTERN.test(intent);
}

/** 意图是否要求完整视频产物。 */
function wantsFullPipeline(intent: string): boolean {
  return /视频|video|配音|完整|成片|mp4|生图|配图/.test(intent);
}

/** registry 是否已注册完整链所需的 domain 工具。 */
const REQUIRED_DOMAIN_TOOLS = [
  "domain.translate",
  "domain.rewrite",
  "domain.seam_repair",
  "domain.terminology",
  "domain.image_prompts",
  "domain.tts",
  "domain.image_gen",
  "domain.subtitle",
  "domain.video_build",
];

function hasRequiredTools(registry: ToolRegistry): boolean {
  return REQUIRED_DOMAIN_TOOLS.every((name) => registry.has(name));
}

/** LLM 抽取 podcast 参数（generateText + Output.object）。 */
async function extractPodcastParams(
  intent: string,
  llm: LlmService,
): Promise<PodcastParams> {
  const model = llm.model("planner");
  const system = [
    "你是 Let-it-Flow 的规划参数抽取器。从用户意图抽取播客生成所需的模板参数。",
    "只输出符合 schema 的结构化对象，不要输出解释。",
    "数据源判定：意图含 URL → sourceMode=url；否则 → sourceMode=topic 并提取主题词作为 topic。",
    "style 判定（5 种）：「对话/对谈」→ dialogue；「转述/叙述」→ narration；「总结/摘要」→ summary；「简报/周报/热点」→ briefing；「对比/对照/双线」→ dual_line；未指定默认 dialogue。",
    "targetMinutes：意图含「X 分钟」「短/长篇」时提取；缺省 30。",
    "emitWechatArticle：意图含「公众号」「文章」「图文」时设 true；缺省 false。",
    "focusHint：若意图明确指向某个角度（如「聚焦在 X」），填到 focusHint。",
  ].join("\n");

  const callArgs = llm.compatMode
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n## 用户意图\n${intent}` }] }
    : { system, messages: [{ role: "user" as const, content: `## 用户意图\n${intent}` }] };

  try {
    const { output } = await generateText({
      model,
      ...callArgs,
      output: Output.object({ schema: PodcastParams }),
      temperature: 0.2,
    });
    if (output) return normalizeParams(output, intent);
    throw new Error("LLM 未返回结构化对象");
  } catch (e) {
    return heuristicParams(intent, e instanceof Error ? e.message : String(e));
  }
}

function normalizeParams(raw: PodcastParams, intent: string): PodcastParams {
  const urls = extractUrls(intent);
  if (urls.length > 0 && raw.sourceMode === "topic") {
    return { ...raw, sourceMode: "url", urls };
  }
  if (raw.sourceMode === "url" && (!raw.urls || raw.urls.length === 0) && urls.length > 0) {
    return { ...raw, urls };
  }
  if (raw.sourceMode === "topic" && !raw.topic) {
    return { ...raw, topic: stripToTopic(intent) };
  }
  return raw;
}

function heuristicParams(intent: string, _err: string): PodcastParams {
  const urls = extractUrls(intent);
  const targetMinutes = extractTargetMinutes(intent);
  const emitWechatArticle = /公众号|图文|微信文章|wechat/i.test(intent);
  const base = {
    style: inferStyle(intent),
    language: "zh",
    maxSearchResults: 5,
    targetMinutes,
    emitWechatArticle,
    // 默认 false：保持向后兼容；调用方/LLM 抽取器可显式开启
    enableSentenceValidator: false,
    enableThreadFocuser: false,
    enableKbLookup: false,
  };
  if (urls.length > 0) {
    return { sourceMode: "url", urls, ...base };
  }
  return { sourceMode: "topic", topic: stripToTopic(intent), ...base };
}

/** 改进 #3：从意图中提取目标分钟数，缺省 30。 */
function extractTargetMinutes(intent: string): number {
  const m = intent.match(/(\d+)\s*分钟/);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (n >= 5 && n <= 90) return n;
  }
  if (/短篇|快报|简短/.test(intent)) return 15;
  if (/长篇|深度|长一点/.test(intent)) return 45;
  return 30;
}

function inferStyle(intent: string): RewriteStyle {
  // 改进 #2：扩展到 5 种叙事结构
  if (/总结|摘要|概括|summary/.test(intent)) return "summary";
  if (/转述|叙述|narration|第三人称/.test(intent)) return "narration";
  if (/简报|周报|热点|briefing|多条/.test(intent)) return "briefing";
  if (/对比|对照|两个|双线|dual/.test(intent)) return "dual_line";
  return "dialogue";
}

/** 改进 #2：叙事结构中文名称（供 KB 检索 / system prompt 引用）。 */
function styleNameZh(style: RewriteStyle): string {
  return {
    dialogue: "对话体",
    narration: "叙述体",
    summary: "总结体",
    briefing: "简报体",
    dual_line: "双线对照体",
  }[style];
}

/** 改进 #2/#3/#5：构建 rewrite 节点的 system prompt（融合多项改进）。 */
function buildRewriteSystemPrompt(
  params: PodcastParams,
  wordPlan: { target: number; tolerance: number; min: number; max: number },
): string {
  const styleGuide: Record<RewriteStyle, string> = {
    dialogue: "改写成两人对谈式播客（A/B 轮流发言）",
    narration: "改写成第三方转述的叙述体旁述",
    summary: "改写成客观的要点总结",
    briefing: "改写成简报体：开场列 3-5 个热点 → 深度展开 2 条 → 趋势观察 → 收尾预告",
    dual_line: "改写成双线对照体：抛出对立观点 → 各自论据 → 交叉对比 → 综合判断",
  };

  return [
    `目标语言：${params.language}。`,
    `叙事结构：${styleNameZh(params.style)}。${styleGuide[params.style]}。`,
    // 改进 #3：字数公式
    `目标时长：${params.targetMinutes} 分钟（字数公式：分钟 × 210 = ${wordPlan.target} 字，容差 ±${wordPlan.tolerance}，即 ${wordPlan.min}-${wordPlan.max} 字）。`,
    // 改进 #4：单句铁律（即使句长校验关闭也提示 LLM）
    `单句铁律：每句 ≤ 25 字；长句必须拆分。`,
    // 改进 #5：KB 注入指引（runtime 注入的 writingRules 会作为 user message 的一部分到达 LLM）
    `如果上下文提供了"writingRules"或"writingRulesText"字段，请遵循其中的术语过滤、引用规范、写稿铁律。`,
    `输出一段完整的播客文稿。`,
  ].join("\n");
}

function stripToTopic(intent: string): string {
  return intent
    .replace(/把|做成|做一期|制作|生成|播客|podcast|关于|的|请/g, "")
    .replace(/https?:\/\/[^\s]+/gi, "")
    .trim() || "未命名主题";
}

/**
 * Podcast 消费应用模板实例（实现 ConsumerTemplate 接口）。
 * 消费应用通过 `import { podcastTemplate } from "./template.js"` 注入到 LetItFlow。
 */
export const podcastTemplate: ConsumerTemplate = {
  templateId: "podcast",
  description: "播客文稿生成：[topic: web_search→web_fetch | url: web_fetch] → rewrite(style) → deliver",
  matchPattern: PODCAST_PATTERN,
  match: (intent: string) => PODCAST_PATTERN.test(intent),
  async extractParams(intent: string, llm: LlmService): Promise<PodcastParams> {
    return extractPodcastParams(intent, llm);
  },
  build: (params: unknown, fullPipeline: boolean): WorkflowDAG => {
    return buildPodcastDag(params as PodcastParams, fullPipeline);
  },
  wantsFullPipeline,
  hasRequiredTools,
  findMissingParams: (intent: string): Array<{ field: string; prompt: string }> => {
    const hasUrl = extractUrls(intent).length > 0;
    const hasTopicSignal = intent.length > 8 || /关于|主题|topic|的/.test(intent);
    if (!hasUrl && !hasTopicSignal) {
      return [{ field: "topic", prompt: "请提供播客主题或素材 URL（如：把 https://... 做成播客，或 做一期关于 AI 的播客）。" }];
    }
    return [];
  },
};
