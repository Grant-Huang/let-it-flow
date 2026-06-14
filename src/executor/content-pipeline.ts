import type { ContentPipelineConfig } from "../planner/dag-schema.js";

/**
 * Content Pipeline —— 数据清洗管道（见 07 §7.6）。
 *
 * 在上游输出注入到本节点前（resolveRef 之后、注入 params 之前）执行，
 * 保护 LLM 上下文窗口不被庞大的现实世界数据撑爆。
 *
 * 三阶段（MVP 实装 strip + truncate，summarize 砍）：
 *   1. strip   — HTML/Markdown 结构净化（剥离残余标签、噪声）
 *   2. summarize — 滚动窗口摘要（MVP 跳过，summarize 永远 false）
 *   3. truncate — 硬截断到 maxTokens 兜底
 *
 * 形状感知（shape-aware）：
 *   - 字符串：走 strip → truncate
 *   - 结构化对象/数组：按 fields 裁剪后透传（不截断数组，保留结构供下游按字段引用）
 *   - 其他（数字/布尔/null）：原样透传
 */

const CHARS_PER_TOKEN = 4;

export function applyContentPipeline(
  value: unknown,
  config: ContentPipelineConfig,
): unknown {
  if (value === null || value === undefined) return value;

  // 结构化对象/数组：按 fields 裁剪后透传（保留结构）
  if (typeof value === "object") {
    return shapePrune(value, config.fields);
  }

  // 字符串：strip → summarize(跳过) → truncate
  if (typeof value === "string") {
    let s = value;
    if (config.strip) s = stripNoise(s);
    // summarize 在 MVP 永远 false（见 ContentPipelineConfig.summarize.default(false)）
    if (config.summarize && config.summarizeModel) {
      // P5+ 实装：调用 summarizeModel 做滚动窗口摘要。
      // MVP 不进入此分支。
    }
    s = truncateToTokens(s, config.maxTokens);
    return s;
  }

  // 数字/布尔等：原样透传
  return value;
}

/**
 * 截断到不超过 maxTokens（按 4 字符/token 估算）。
 * 在 token 边界附近按词/句截断，避免切断中文字/单词。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  // 在 maxChars 附近找最近的空白/标点边界
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf("。"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf(" "),
  );
  const end = boundary > maxChars * 0.5 ? boundary : maxChars;
  return `${text.slice(0, end).trimEnd()}…[truncated]`;
}

/**
 * HTML/Markdown 结构净化（见 07 §7.6 strip）。
 * web_fetch 已做过粗提取；这里做二次净化：
 *   - 移除残余 HTML 标签
 *   - 压缩连续空白
 *   - 移除 markdown 图片/链接，保留链接文本
 *   - 移除代码块外的围栏（保留代码内容）
 */
export function stripNoise(text: string): string {
  return text
    // 残余 HTML 标签（<...>）—— 但保留 < 不被误删（仅删成对标签形态）
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // markdown 图片 ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // markdown 链接 [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // markdown 标题井号保留（结构性）
    // 连续空行压缩
    .replace(/\n{3,}/g, "\n\n")
    // 行尾空白
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** 按 fields 裁剪对象/数组（shape-aware 透传）。 */
function shapePrune(value: object, fields?: string[]): unknown {
  if (!fields || fields.length === 0) return value;
  // fields 仅作用于普通对象，数组透传（逐元素递归裁剪）
  if (Array.isArray(value)) {
    return value.map((v) => (v !== null && typeof v === "object" ? shapePrune(v, fields) : v));
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
    return value;
  }
  const out: Record<string, unknown> = {};
  const rec = value as Record<string, unknown>;
  for (const f of fields) {
    if (f in rec) out[f] = rec[f];
  }
  return out;
}
