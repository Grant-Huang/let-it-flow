import { createSkill } from "../../../src/agent/skill-bridge.js";
import type { EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

export interface PodcastScriptOutput {
  script: string;
  segmentBreakdown: Array<{
    segment: string;
    wordCount: number;
    estimatedDuration: number;
  }>;
  estimatedDurationMin: number;
  citationList: Array<{ text: string; source: string }>;
  evidence: EvidenceEnvelope;
}

export const writePodcastScriptSkill = createSkill({
  name: "skill.write_podcast_script",
  description: "根据聚焦线索和叙事结构撰写口播稿，内置字数、句长、术语校验",
  inputSchema: {
    type: "object" as const,
    properties: {
      focusedThread: {
        type: "object",
        description: "聚焦后的核心线索（来自 thread_focuser）",
      },
      narrative: {
        type: "string",
        description: "选定的叙事结构类型（suspense|analyst|briefing|dual-line）",
      },
      durationMinutes: {
        type: "number",
        description: "目标时长（分钟）",
        default: 30,
      },
      language: {
        type: "string",
        description: "语言（zh|en）",
        default: "zh",
      },
    },
    required: ["focusedThread", "narrative"],
  },

  async steps(input) {
    const { step } = input;
    const targetMinutes = input.durationMinutes || 30;
    const targetWords = targetMinutes * 210; // 字数公式
    const tolerance = targetWords * 0.05; // ±5% 容差

    // Step 1: 从知识库拉取写稿铁律
    const rulesStep = await step("获取写稿铁律", async (ctx) => {
      const rules = await ctx.call<{ rules: Record<string, string> }>("kb.search", {
        query: `写稿铁律 ${input.language === "zh" ? "中文" : "英文"}`,
        scope: "podcast-skill",
      });
      return rules;
    });

    const rulesContext = rulesStep.rules ? Object.values(rulesStep.rules).join("\n\n") : "";

    // Step 2: 第一轮生成
    const draftStep = await step("初稿生成", async (ctx) => {
      const draft = await ctx.call<{ script: string; segments: string[] }>("generate", {
        systemPrompt: `你是播客写稿专家。按照叙事结构写稿。

## 写稿铁律
${rulesContext}

## 约束
- 目标字数: ${targetWords} ±${tolerance}字
- 单句不超过25字
- 避免术语堆砌

## 叙事结构: ${input.narrative}`,
        userPrompt: `为以下线索写${targetMinutes}分钟口播稿：\n\n${JSON.stringify(input.focusedThread)}\n\nJSON 格式返回: { script: "完整稿件", segments: ["段落1", "段落2", ...] }`,
      });
      return draft;
    });

    const scriptDraft = draftStep.script || "";
    const segments = draftStep.segments || [];

    // Step 3: 自校验
    const validateStep = await step("字数/句长/术语校验", async (ctx) => {
      const result = await ctx.call<{
        wordCount: number;
        maxSentenceLength: number;
        violations: string[];
        needsRevise: boolean;
      }>("thought", {
        directive: `校验以下稿件：
文本: ${scriptDraft}

检查项：
1. 总字数: 应为 ${targetWords} ±${tolerance}
2. 单句长度: 不超过25字
3. 术语过滤: 避免 ChatGPT/CEO/GDP 等常见术语的裸露解释

返回: { wordCount, maxSentenceLength, violations: [], needsRevise: boolean }`,
      });
      return result;
    });

    let finalScript = scriptDraft;
    if (validateStep.needsRevise) {
      // 自动重写
      const reviseStep = await step("自动重写", async (ctx) => {
        const revised = await ctx.call<{ script: string }>("generate", {
          systemPrompt: `修改播客稿件，修复以下问题：${validateStep.violations.join("；")}`,
          userPrompt: `原稿件：\n${scriptDraft}\n\n修改后的完整稿件：`,
        });
        return revised;
      });
      finalScript = reviseStep.script || scriptDraft;
    }

    // Step 4: 提取引用
    const citationsStep = await step("提取引用", async (ctx) => {
      const citations = await ctx.call<{
        citations: Array<{ text: string; source: string }>;
      }>("thought", {
        directive: `从以下稿件中提取所有直接引用或信源引用：
${finalScript}

返回: { citations: [{ text: "引用内容", source: "信源" }, ...] }`,
      });
      return citations;
    });

    const wordCount = finalScript.length;
    const estimatedMin = Math.round(wordCount / 210);
    const segmentBreakdown = segments.map((seg, idx) => ({
      segment: `Segment ${idx + 1}`,
      wordCount: seg.length,
      estimatedDuration: Math.round(seg.length / 210),
    }));

    const output: PodcastScriptOutput = {
      script: finalScript,
      segmentBreakdown,
      estimatedDurationMin: estimatedMin,
      citationList: citationsStep.citations || [],
      evidence: {
        provenance: "skill.write_podcast_script",
        confidence: "generated",
        freshness: new Date().toISOString(),
        data: {
          targetMinutes,
          actualMinutes: estimatedMin,
          wordCount,
          segments: segments.length,
        },
      },
    };

    return output;
  },
});
