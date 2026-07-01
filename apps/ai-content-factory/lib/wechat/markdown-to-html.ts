/**
 * Markdown → 微信草稿 HTML 转换工具。
 *
 * write-wechat-article skill 产出 markdown（## 标题、**加粗**、![](...) 图片、> 引用）。
 * 微信草稿 draft/add 的 content 字段只接受 HTML，且要求：
 *   - 正文图片 URL 必须来自 uploadimg 接口（外部 URL 会被过滤）
 *   - JS 会被剥离；只支持部分 HTML 标签
 *
 * 流程：markdownToHtml（marked）→ extractImageUrls（找外链）→
 *       skill 上传后得到微信 URL → replaceImageUrls（替换）→ sanitizeForWechat（净化）
 */
import { marked } from "marked";

/** 配置 marked：GitHub 风格、不需要 mangle/headerIds（避免 id 噪音）。 */
marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Markdown 转 HTML。
 *
 * 使用 marked（轻量标准库，~12KB，活跃维护）。
 */
export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

/**
 * 从 HTML 中提取所有 <img src>（去重，保序）。
 *
 * 同时支持双引号和单引号包裹的 src。
 */
export function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /<img[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1] ?? m[2];
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * 按映射批量替换 HTML 中的图片 src。
 *
 * @param html    原 HTML
 * @param mapping 旧 URL → 新（微信）URL；未在映射中的 URL 保留原样
 */
export function replaceImageUrls(html: string, mapping: Record<string, string>): string {
  if (Object.keys(mapping).length === 0) return html;
  return html.replace(
    /(<img[^>]*\bsrc\s*=\s*)(?:"([^"]+)"|'([^']+)')/gi,
    (full, prefix: string, dq: string | undefined, sq: string | undefined) => {
      const oldUrl = dq ?? sq ?? "";
      const newUrl = mapping[oldUrl];
      if (!newUrl) return full;
      const quote = dq !== undefined ? '"' : "'";
      return `${prefix}${quote}${newUrl}${quote}`;
    },
  );
}

/**
 * 净化 HTML，符合微信草稿 content 要求。
 *
 * - 剥离 <script>/<iframe>/<object>/<embed>（微信也会剥离 JS，这里提前做避免脏数据）
 * - 剥离所有 on* 内联事件属性（onclick/onload 等，防 XSS）
 * - 保留微信支持的白名单标签：h1-h6, p, strong, em, br, img, blockquote, ul, ol, li, a, hr, span, section, pre, code
 */
const BLOCKED_TAGS = /<(script|iframe|object|embed|style)[\s\S]*?<\/\1\s*>/gi;
const BLOCKED_SELF_CLOSE = /<(script|iframe|object|embed|style)[^>]*\/?>/gi;
const ON_EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function sanitizeForWechat(html: string): string {
  return html
    .replace(BLOCKED_TAGS, "")
    .replace(BLOCKED_SELF_CLOSE, "")
    .replace(ON_EVENT_ATTR, "");
}
