import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import {
  toolCallPayload,
  toolResultPayload,
} from "../../core/stream-events.js";
import { generateText } from "ai";
import type { LlmService } from "../../services/llm-service.js";

/**
 * 公众号长文生成工具（podcast-generator 改进 #6）。
 *
 * 输入：基于已生成的口播稿、聚焦线索说明，扩展成公众号长文。
 *   - 默认目标字数 6500（约 ~5 倍口播稿字数）
 *   - 自校验字数，超出 ±5% 容差时调 LLM 调整
 *
 * 产出：公众号长文 + section outline。
 */
const inputSchema = z.object({
  podcastScript: z.string().describe("已生成的口播稿"),
  focusedThread: z.string().optional().describe("聚焦的主线索说明"),
  narrativeReason: z.string().optional().describe("叙事结构选择理由"),
  targetWords: z.number().int().positive().default(6500).describe("目标字数"),
  language: z.string().default("zh").describe("目标语言"),
});

export interface WechatArticleOutput {
  article: string;
  sectionOutline: Array<{ title: string; wordCount: number }>;
  actualWords: number;
  passedWordCheck: boolean;
}

export interface WechatArticleDeps {
  llm: LlmService;
}

function extractSectionOutline(article: string): Array<{ title: string; wordCount: number }> {
  const lines = article.split("\n");
  const sections: Array<{ title: string; wordCount: number }> = [];
  let currentTitle = "";
  let currentContent = "";

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (currentTitle) {
        sections.push({ title: currentTitle, wordCount: currentContent.replace(/\s/g, "").length });
      }
      currentTitle = headerMatch[1] ?? "";
      currentContent = "";
    } else {
      currentContent += line;
    }
  }
  if (currentTitle) {
    sections.push({ title: currentTitle, wordCount: currentContent.replace(/\s/g, "").length });
  }
  return sections;
}

function countChineseWords(text: string): number {
  return text.replace(/\s/g, "").length;
}

export function createWechatArticleTool(deps: WechatArticleDeps): FlowConnector<WechatArticleOutput> {
  return {
    name: "domain.write_wechat_article",
    tier: "domain",
    description: "公众号长文生成：基于口播稿扩展为 6500 字图文（## 二级标题、短段、加粗重点）",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["公众号文章", "长文生成", "图文稿", "微信公众号"],
      notFor: ["口播稿（走 rewrite）", "纯总结（走 llm_node）"],
    },
    outputSchema: {
      type: "object",
      description: "公众号长文与章节摘要",
      properties: {
        article: { type: "string", description: "完整文章" },
        sectionOutline: { type: "array", description: "章节摘要" },
        actualWords: { type: "number", description: "实际字数" },
        passedWordCheck: { type: "boolean", description: "是否通过字数校验" },
      },
    },
    outputExample: { article: "## 引言\n...", sectionOutline: [], actualWords: 6500, passedWordCheck: true },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<WechatArticleOutput>> {
      const args = inputSchema.parse(params);
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const tolerance = Math.round(args.targetWords * 0.05);

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.write_wechat_article",
          args: { targetWords: args.targetWords, scriptLen: args.podcastScript.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "writer",
        }),
      };

      const model = deps.llm.model("writer");
      const systemPrompt = `你是公众号资深编辑。基于以下口播稿和叙事思路，扩展成公众号长文。

## 约束
- 目标字数: ${args.targetWords} ±${tolerance}
- 使用 ## 二级标题分章
- 每段 80-150 字
- 关键词加粗（**关键词**）
- 避免列表过长（≤5 条）
- 语言：${args.language}`;

      const userPrompt = `请基于以下口播稿，扩展为公众号长文（${args.targetWords}字左右）：

## 口播稿
${args.podcastScript}

${args.focusedThread ? `## 核心线索\n${args.focusedThread}\n` : ""}
${args.narrativeReason ? `## 叙事结构理由\n${args.narrativeReason}\n` : ""}

请直接输出 Markdown 格式的完整文章。`;

      const { text } = await generateText({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature: 0.7,
      } as never);

      let finalArticle = text;
      let actualWords = countChineseWords(finalArticle);
      let passedWordCheck = Math.abs(actualWords - args.targetWords) <= tolerance;

      // 若超出容差，调一次 LLM 调整
      if (!passedWordCheck) {
        const adjustPrompt = `原文字数 ${actualWords}，目标 ${args.targetWords} ±${tolerance}。请${actualWords > args.targetWords ? "精简" : "扩展"}至目标字数。

原文：
${finalArticle}

调整后：`;

        const { text: adjusted } = await generateText({
          model,
          messages: [{ role: "user", content: adjustPrompt }],
          temperature: 0.5,
        } as never);
        finalArticle = adjusted;
        actualWords = countChineseWords(finalArticle);
        passedWordCheck = Math.abs(actualWords - args.targetWords) <= tolerance;
      }

      const sectionOutline = extractSectionOutline(finalArticle);
      const output: WechatArticleOutput = {
        article: finalArticle,
        sectionOutline,
        actualWords,
        passedWordCheck,
      };

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, actualWords, passedWordCheck, sections: sectionOutline.length }),
        }),
      };

      return {
        output,
        summary: `公众号文章完成：${actualWords} 字（目标 ${args.targetWords}）${passedWordCheck ? " ✓" : " ⚠ 超出容差"}`,
      };
    },
  };
}
