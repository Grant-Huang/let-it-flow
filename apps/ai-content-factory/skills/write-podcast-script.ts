import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";

export interface PodcastScriptOutput {
  script: string;
  segmentBreakdown: Array<{
    segment: string;
    wordCount: number;
    estimatedDuration: number;
  }>;
  estimatedDurationMin: number;
  citationList: Array<{ text: string; source: string }>;
  evidence: ReturnType<typeof wrapEvidence>;
}

export const writePodcastScriptSkill = createSkill({
  name: "skill.write_podcast_script",
  description: "根据聚焦线索和叙事结构撰写口播稿，内置字数、句长、术语校验",
  whenToUse: {
    triggers: ["写口播稿", "生成播客文稿", "撰写稿件"],
    notFor: ["聚焦线索（走 thread_focuser）", "写公众号长文（走 write_wechat_article）"],
  },
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
  outputSchema: {
    type: "object",
    properties: {
      script: { type: "string" },
      estimatedDurationMin: { type: "number" },
      citationList: { type: "array" },
    },
  },
  outputExample: {
    script: "（口播稿正文）",
    estimatedDurationMin: 30,
    citationList: [],
  },

  async steps(input) {
    const { step } = input;
    const targetMinutes = typeof input.durationMinutes === "number" ? input.durationMinutes : 30;
    const targetWords = targetMinutes * 210; // 字数公式
    const tolerance = targetWords * 0.05; // ±5% 容差
    const language = typeof input.language === "string" ? input.language : "zh";
    const focusedThread = input.focusedThread;
    const narrative = typeof input.narrative === "string" ? input.narrative : "briefing";

    // Step 1: 从知识库拉取写稿铁律
    const rulesStep = await step<string | undefined>("获取写稿铁律", async (ctx) => {
      const envelope = await ctx.call<{
        data?: { results?: Array<{ data?: { content?: string } }> };
      }>("kb.search", {
        query: `写稿铁律 ${language === "zh" ? "中文" : "英文"}`,
      });
      // kb.search 返回 EvidenceEnvelope<{results: EvidenceEnvelope<Snippet>[]}>
      // 把命中的片段正文拼接成铁律上下文
      const results = envelope?.data?.results ?? [];
      return results.map((r) => r?.data?.content ?? "").filter(Boolean).join("\n\n");
    });

    const rulesContext = rulesStep ?? "";

    // Step 2: 第一轮生成
    const draftStep = await step<{ script: string; segments: string[] } | undefined>("初稿生成", async (ctx) => {
      const draft = await ctx.call<{ script: string; segments: string[] }>("generate", {
        systemPrompt: `你是播客写稿专家。按照叙事结构写稿。

## 写稿铁律
${rulesContext}

## 约束
- 目标字数: ${targetWords} ±${tolerance}字
- 单句不超过25字
- 避免术语堆砌

## 叙事结构: ${narrative}`,
        userPrompt: `为以下线索写${targetMinutes}分钟口播稿：\n\n${JSON.stringify(focusedThread)}\n\nJSON 格式返回: { script: "完整稿件", segments: ["段落1", "段落2", ...] }`,
      });
      return draft;
    });

    const scriptDraft = draftStep?.script || "";
    const segments = draftStep?.segments || [];

    // Step 3: 自校验
    const validateStep = await step<{
      wordCount: number;
      needsRevise: boolean;
      violations: string[];
    } | undefined>("字数/句长/术语校验", async (ctx) => {
      const result = await ctx.call<{
        wordCount: number;
        needsRevise: boolean;
        violations: string[];
      }>("thought", {
        directive: `校验以下稿件：
文本: ${scriptDraft}

检查项：
1. 总字数: 应为 ${targetWords} ±${tolerance}
2. 单句长度: 不超过25字
3. 术语过滤: 避免 ChatGPT/CEO/GDP 等常见术语的裸露解释

返回: { wordCount, needsRevise: boolean, violations: [] }`,
      });
      return result;
    });

    let finalScript = scriptDraft;
    if (validateStep?.needsRevise) {
      const reviseStep = await step<{ script: string } | undefined>("自动重写", async (ctx) => {
        const revised = await ctx.call<{ script: string }>("generate", {
          systemPrompt: `修改播客稿件，修复以下问题：${(validateStep.violations || []).join("；")}`,
          userPrompt: `原稿件：\n${scriptDraft}\n\n修改后的完整稿件（JSON: {script:"..."}）：`,
        });
        return revised;
      });
      finalScript = reviseStep?.script || scriptDraft;
    }

    // Step 4: 提取引用
    const citationsStep = await step<{ citations: Array<{ text: string; source: string }> } | undefined>(
      "提取引用",
      async (ctx) => {
        const citations = await ctx.call<{
          citations: Array<{ text: string; source: string }>;
        }>("thought", {
          directive: `从以下稿件中提取所有直接引用或信源引用：
${finalScript}

返回: { citations: [{ text: "引用内容", source: "信源" }, ...] }`,
        });
        return citations;
      },
    );

    const wordCount = finalScript.length;
    const estimatedMin = Math.round(wordCount / 210);
    const segmentBreakdown = segments.map((seg, idx) => ({
      segment: `Segment ${idx + 1}`,
      wordCount: seg.length,
      estimatedDuration: Math.round(seg.length / 210),
    }));

    const evidence = wrapEvidence(
      {
        targetMinutes,
        actualMinutes: estimatedMin,
        wordCount,
        segments: segments.length,
        scriptPreview: finalScript.slice(0, 200),
      },
      {
        freshness: "realtime",
        confidence: "estimated",
        system: "llm",
        provenance: "skill.write_podcast_script",
      },
    );

    const output: PodcastScriptOutput = {
      script: finalScript,
      segmentBreakdown,
      estimatedDurationMin: estimatedMin,
      citationList: citationsStep?.citations || [],
      evidence,
    };

    return output;
  },
});
