import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * 自定义 markdown 渲染。
 *
 * 核心能力：识别 `[text](#artifact:<id>)` 链接协议，把它渲染为
 * `<a data-artifact-id="<id>" class="nexus-artifact-link">`，
 * 点击时由父容器委托捕获 → 切换右栏产物 tab。
 *
 * 安全：marked 解析后用 DOMPurify 清理 XSS，并放行 data-artifact-id 属性。
 */

marked.setOptions({
  gfm: true,
  breaks: false,
});

/** 让 marked 识别 #artifact:<id> 协议，输出带 data-artifact-id 的链接。 */
const renderer = {
  link({ href, tokens }: { href: string; tokens: { text: string }[] }) {
    const text = (this.parser.parseInline(tokens) ?? "") as string;
    const m = /^#artifact:(.+)$/.exec(href);
    if (m) {
      const id = m[1]!;
      return `<a href="#artifact:${id}" data-artifact-id="${escapeAttr(id)}" class="nexus-artifact-link">${text}</a>`;
    }
    // 外部链接新开标签
    const safe = /^(https?:|mailto:)/.test(href) ? href : "#";
    return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};

// marked 18+ 支持 walkTokens/renderer 透传；类型用 any 规避版本差异
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(marked as any).use({ renderer });

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 把 markdown 源串渲染为已消毒的 HTML 字符串。
 * 产物链接 `#artifact:<id>` 会被转为可点击的 <a data-artifact-id>。
 */
export function renderMarkdown(source: string): string {
  if (!source) return "";
  const raw = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["data-artifact-id", "target", "rel"],
    ADD_CLASS: ["nexus-artifact-link"],
  });
}
