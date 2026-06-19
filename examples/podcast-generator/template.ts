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

export type RewriteStyle = "dialogue" | "narration" | "summary";

/** Podcast 模板参数（planner LLM 抽取填充）。 */
export const PodcastParams = z.object({
  sourceMode: z.enum(["topic", "url"]),
  topic: z.string().optional(),
  urls: z.array(z.string().url()).optional(),
  style: z.enum(["dialogue", "narration", "summary"]).default("dialogue"),
  language: z.string().default("zh"),
  rewriteHint: z.string().optional(),
  maxSearchResults: z.number().int().positive().max(10).default(5),
});
export type PodcastParams = z.infer<typeof PodcastParams>;

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
      inputRefs: { "$.tasks.fetch.output[0].content": "context" },
      dependsOn: [firstNodeId],
      requireConfirmation: true,
      onNodeError: "abort",
      contentPipeline: { maxTokens: 6000, strip: true, summarize: false },
    });
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
    "style 判定：明确要求「对话/对谈」→ dialogue；「转述/叙述」→ narration；「总结/摘要」→ summary；未指定默认 dialogue。",
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
  if (urls.length > 0) {
    return { sourceMode: "url", urls, style: inferStyle(intent), language: "zh", maxSearchResults: 5 };
  }
  return { sourceMode: "topic", topic: stripToTopic(intent), style: inferStyle(intent), language: "zh", maxSearchResults: 5 };
}

function inferStyle(intent: string): RewriteStyle {
  if (/总结|摘要|概括|summary/.test(intent)) return "summary";
  if (/转述|叙述|narration|第三人称/.test(intent)) return "narration";
  return "dialogue";
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
