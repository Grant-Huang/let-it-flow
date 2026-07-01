/**
 * markdown-to-html 工具单测。
 *
 * 覆盖：
 *   - markdownToHtml：基本标题/加粗/图片/引用转换
 *   - extractImageUrls：从 HTML 提取 <img src>，去重
 *   - replaceImageUrls：按映射批量替换 src
 *   - sanitizeForWechat：剥离 <script>/<iframe>，保留白名单标签
 */
import { describe, it, expect } from "vitest";
import {
  markdownToHtml,
  extractImageUrls,
  replaceImageUrls,
  sanitizeForWechat,
} from "../../../../apps/ai-content-factory/lib/wechat/markdown-to-html.js";

describe("markdownToHtml", () => {
  it("把 ## 标题转为 <h2>", () => {
    expect(markdownToHtml("## 标题")).toContain("<h2");
  });

  it("把 **加粗** 转为 <strong>", () => {
    expect(markdownToHtml("**重点**")).toContain("<strong>重点</strong>");
  });

  it("把 ![](url) 转为 <img>", () => {
    const html = markdownToHtml("![alt](https://a.com/x.png)");
    expect(html).toContain("<img");
    expect(html).toContain('src="https://a.com/x.png"');
  });

  it("把 > 引用转为 <blockquote>", () => {
    expect(markdownToHtml("> 引用")).toContain("<blockquote");
  });
});

describe("extractImageUrls", () => {
  it("提取所有 <img src>，按出现顺序去重", () => {
    const html = '<p><img src="https://a.com/1.png"/><img src="https://a.com/2.png"/><img src="https://a.com/1.png"/></p>';
    expect(extractImageUrls(html)).toEqual(["https://a.com/1.png", "https://a.com/2.png"]);
  });

  it("单引号 src 也能提取", () => {
    expect(extractImageUrls("<img src='https://b.com/y.jpg'>")).toEqual(["https://b.com/y.jpg"]);
  });

  it("无图返回空数组", () => {
    expect(extractImageUrls("<p>纯文本</p>")).toEqual([]);
  });
});

describe("replaceImageUrls", () => {
  it("按映射批量替换 src", () => {
    const html = '<img src="https://a.com/1.png"/><img src="https://a.com/2.png"/>';
    const out = replaceImageUrls(html, {
      "https://a.com/1.png": "https://mmbiz.qpic.cn/wx1.png",
      "https://a.com/2.png": "https://mmbiz.qpic.cn/wx2.png",
    });
    expect(out).toContain('src="https://mmbiz.qpic.cn/wx1.png"');
    expect(out).toContain('src="https://mmbiz.qpic.cn/wx2.png"');
    expect(out).not.toContain("a.com");
  });

  it("映射中未覆盖的 URL 保留原样", () => {
    const out = replaceImageUrls('<img src="https://a.com/1.png"/>', {});
    expect(out).toContain('src="https://a.com/1.png"');
  });
});

describe("sanitizeForWechat", () => {
  it("剥离 <script> 块", () => {
    const out = sanitizeForWechat("<p>ok</p><script>alert(1)</script>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>ok</p>");
  });

  it("剥离 <iframe>", () => {
    const out = sanitizeForWechat('<iframe src="x"></iframe><p>hi</p>');
    expect(out).not.toContain("iframe");
    expect(out).toContain("<p>hi</p>");
  });

  it("保留微信支持的白名单标签", () => {
    const html = "<h2>标题</h2><p>段</p><strong>粗</strong><blockquote>引</blockquote>";
    const out = sanitizeForWechat(html);
    expect(out).toContain("<h2>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<blockquote>");
  });

  it("剥离 on* 事件属性", () => {
    const out = sanitizeForWechat('<p onclick="evil()">text</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("<p>text</p>");
  });
});
