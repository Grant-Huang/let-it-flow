import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

export interface WechatArticleOutput {
  article: string;
  sectionOutline: Array<{
    title: string;
    wordCount: number;
  }>;
  citationList: Array<{ text: string; source: string }>;
  evidence: ReturnType<typeof wrapEvidence>;
}

export const writeWechatArticleSkill = createSkill({
  name: "skill.write_wechat_article",
  description: "基于聚焦线索和口播稿决策，撰写公众号长文（6500字左右）",
  whenToUse: {
    triggers: ["写公众号文章", "生成长文", "扩展成图文"],
    notFor: ["写口播稿（走 write_podcast_script）", "聚焦线索（走 thread_focuser）"],
  },
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
  outputSchema: {
    type: "object",
    properties: {
      article: { type: "string" },
      sectionOutline: { type: "array" },
      citationList: { type: "array" },
    },
  },
  outputExample: {
    article: "（公众号文章正文）",
    sectionOutline: [{ title: "章节", wordCount: 800 }],
    citationList: [],
  },

  async steps(input) {
    const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
    const targetWords = typeof input.targetWords === "number" ? input.targetWords : 6500;
    const tolerance = targetWords * 0.05; // ±5% 容差
    const focusedThread = input.focusedThread;
    const narrativeReason = typeof input.narrativeReason === "string" ? input.narrativeReason : "";
    const podcastScript = typeof input.podcastScript === "string" ? input.podcastScript : "";

    await skillNarrate(`我来扩展成公众号长文（${targetWords} 字左右）。`);

    // Step 1: 获取图文写作规范
    const rulesStep = await step<string | undefined>("获取图文规范", async (ctx) => {
      await narrate(ctx, "正在从知识库取图文规范…");
      const envelope = await ctx.call<{
        data?: { results?: Array<{ data?: { content?: string } }> };
      }>("kb.search", {
        query: "图文写作规范 公众号",
      });
      const results = envelope?.data?.results ?? [];
      await narrate(ctx, `找到 ${results.length} 条图文规范。`);
      return results.map((r) => r?.data?.content ?? "").filter(Boolean).join("\n\n");
    });

    const rulesContext = rulesStep ?? "";

    // Step 2: 生成长文稿
    const draftStep = await step<{
      article: string;
      sections: Array<{ title: string; content: string }>;
    } | undefined>("长文生成", async (ctx) => {
      await narrate(ctx, "正在生成长文稿…");
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
${podcastScript}`,
        userPrompt: `请为以下线索写公众号长文（${targetWords}字左右）：\n\n线索：${JSON.stringify(focusedThread)}\n\n结构理由：${narrativeReason}\n\nJSON 返回: { article: "完整文章", sections: [{ title: "...", content: "..." }, ...] }`,
      });
      await narrate(ctx, `生成长文稿约 ${(draft?.article ?? "").length} 字，${draft?.sections.length ?? 0} 章节。`);
      return draft;
    });

    const articleDraft = draftStep?.article || "";
    const sections = draftStep?.sections || [];

    // Step 3: 字数校验
    const validateStep = await step<{
      wordCount: number;
      needsRevise: boolean;
      issue: string;
    } | undefined>("字数校验", async (ctx) => {
      await narrate(ctx, "正在校验字数…");
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
      await narrate(
        ctx,
        `实际 ${result?.wordCount ?? 0} 字，目标 ${targetWords} 字${result?.needsRevise ? "（需调整）" : "（达标）"}。`,
      );
      return result;
    });

    let finalArticle = articleDraft;
    if (validateStep?.needsRevise) {
      const issue = validateStep.issue || "字数偏差";
      await skillNarrate(`字数不达标（${issue}），触发调整。`);
      const reviseStep = await step<{ article: string } | undefined>("字数调整", async (ctx) => {
        await narrate(ctx, "正在调整字数…");
        const issueInner = validateStep.issue || "";
        const revised = await ctx.call<{ article: string }>("generate", {
          systemPrompt: `修改公众号文章，调整字数到 ${targetWords} 字（${issue}）`,
          userPrompt: `原文：\n${articleDraft}\n\n修改后的完整文章（JSON: {article:"..."}）：`,
        });
        return revised;
      });
      finalArticle = reviseStep?.article || articleDraft;
    }

    // Step 4: 提取引用
    const citationsStep = await step<{ citations: Array<{ text: string; source: string }> } | undefined>(
      "提取引用",
      async (ctx) => {
        await narrate(ctx, "正在提取信源…");
        const citations = await ctx.call<{
          citations: Array<{ text: string; source: string }>;
        }>("thought", {
          directive: `从以下文章中提取所有直接引用和信源：
${finalArticle}

返回: { citations: [{ text: "引用内容", source: "信源" }, ...] }`,
        });
        await narrate(ctx, `提取 ${citations?.citations?.length ?? 0} 条引用。`);
        return citations;
      },
    );

    const wordCount = finalArticle.length;
    const sectionOutline = sections.map((sec) => ({
      title: sec.title,
      wordCount: sec.content?.length || 0,
    }));

    await skillSummary(
      `公众号长文完成，${sections.length} 章节约 ${wordCount} 字。`,
    );

    const evidence = wrapEvidence(
      {
        targetWords,
        actualWords: wordCount,
        sections: sections.length,
        articlePreview: finalArticle.slice(0, 200),
      },
      {
        freshness: "realtime",
        confidence: "estimated",
        system: "llm",
        provenance: "skill.write_wechat_article",
      },
    );

    const output: WechatArticleOutput = {
      article: finalArticle,
      sectionOutline,
      citationList: citationsStep?.citations || [],
      evidence,
    };

    return output;
  },
});
