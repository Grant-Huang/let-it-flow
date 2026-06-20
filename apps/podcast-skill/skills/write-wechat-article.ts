import { createSkill } from "../../../src/agent/skill-bridge.js";
import type { EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

export interface WechatArticleOutput {
  article: string;
  sectionOutline: Array<{
    title: string;
    wordCount: number;
  }>;
  citationList: Array<{ text: string; source: string }>;
  evidence: EvidenceEnvelope;
}

export const writeWechatArticleSkill = createSkill({
  name: "skill.write_wechat_article",
  description: "基于聚焦线索和口播稿决策，撰写公众号长文（6500字左右）",
  inputSchema: {
    type: "object" as const,
    properties: {
      focusedThread: {
        type: "object",
        description: "聚焦后的核心线索",
      },
      narrativeReason: {
        type: "string",
        description: "选定叙事结构的理由",
      },
      podcastScript: {
        type: "string",
        description: "已生成的口播稿（作为参考和基础）",
      },
      targetWords: {
        type: "number",
        description: "目标字数",
        default: 6500,
      },
    },
    required: ["focusedThread", "narrativeReason", "podcastScript"],
  },

  async steps(input) {
    const { step } = input;
    const targetWords = input.targetWords || 6500;
    const tolerance = targetWords * 0.05; // ±5% 容差

    // Step 1: 获取图文写作规范
    const rulesStep = await step("获取图文规范", async (ctx) => {
      const rules = await ctx.call<{ standards: Record<string, string> }>("kb.search", {
        query: "图文写作规范 公众号",
        scope: "podcast-skill",
      });
      return rules;
    });

    const rulesContext = rulesStep.standards
      ? Object.values(rulesStep.standards).join("\n\n")
      : "";

    // Step 2: 生成长文稿
    const draftStep = await step("长文生成", async (ctx) => {
      const draft = await ctx.call<{
        article: string;
        sections: Array<{ title: string; content: string }>;
      }>("generate", {
        systemPrompt: `你是公众号资深编辑。基于以下口播稿和叙事思路，扩展成公众号长文。

## 图文规范
${rulesContext}

## 约束
- 目标字数: ${targetWords} ±${tolerance}
- 使用 ## 二级标题分章
- 每段 80-150 字
- 关键词加粗
- 避免列表过长

## 口播稿参考
${input.podcastScript}`,
        userPrompt: `请为以下线索写公众号长文（${targetWords}字左右）：\n\n线索：${JSON.stringify(input.focusedThread)}\n\n结构理由：${input.narrativeReason}\n\nJSON 返回: { article: "完整文章", sections: [{ title: "...", content: "..." }, ...] }`,
      });
      return draft;
    });

    const articleDraft = draftStep.article || "";
    const sections = draftStep.sections || [];

    // Step 3: 字数校验
    const validateStep = await step("字数校验", async (ctx) => {
      const result = await ctx.call<{
        wordCount: number;
        needsRevise: boolean;
        issue: string;
      }>("thought", {
        directive: `检查以下文章的字数：
文本: ${articleDraft}

目标: ${targetWords} 字，容差 ±${tolerance} 字
实际字数与目标的差异是否超过容差？

返回: { wordCount, needsRevise: boolean, issue: "" }`,
      });
      return result;
    });

    let finalArticle = articleDraft;
    if (validateStep.needsRevise) {
      const reviseStep = await step("字数调整", async (ctx) => {
        const issue = validateStep.issue || "";
        const revised = await ctx.call<{ article: string }>("generate", {
          systemPrompt: `修改公众号文章，调整字数到 ${targetWords} 字（${issue}）`,
          userPrompt: `原文：\n${articleDraft}\n\n修改后的完整文章：`,
        });
        return revised;
      });
      finalArticle = reviseStep.article || articleDraft;
    }

    // Step 4: 提取引用
    const citationsStep = await step("提取引用", async (ctx) => {
      const citations = await ctx.call<{
        citations: Array<{ text: string; source: string }>;
      }>("thought", {
        directive: `从以下文章中提取所有直接引用和信源：
${finalArticle}

返回: { citations: [{ text: "引用内容", source: "信源" }, ...] }`,
      });
      return citations;
    });

    const wordCount = finalArticle.length;
    const sectionOutline = sections.map((sec) => ({
      title: sec.title,
      wordCount: sec.content?.length || 0,
    }));

    const output: WechatArticleOutput = {
      article: finalArticle,
      sectionOutline,
      citationList: citationsStep.citations || [],
      evidence: {
        provenance: "skill.write_wechat_article",
        confidence: "generated",
        freshness: new Date().toISOString(),
        data: {
          targetWords,
          actualWords: wordCount,
          sections: sections.length,
        },
      },
    };

    return output;
  },
});
