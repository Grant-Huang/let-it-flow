import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

export interface Thread {
  id: string;
  summary: string;
  evidence: string;
  argumentSpace: number; // 0-10, 能否独立撑起一期
}

export interface ThreadFocuserOutput {
  selected: Thread;
  discarded: Thread[];
  contentType: "rigorous" | "comprehensive";
  rationale: string;
  evidence: ReturnType<typeof wrapEvidence>;
}

export const threadFocuserSkill = createSkill({
  name: "skill.thread_focuser",
  description: "从多条内容线索中聚焦出单一主线索，判定内容类型（严谨型 vs 综合型）",
  whenToUse: {
    triggers: ["聚焦单一主线", "从多个线索选一个", "判定内容类型"],
    notFor: ["已经有明确单一线索", "需要写稿（走 write_podcast_script）"],
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      sourceText: {
        type: "string",
        description: "源内容文本（搜索结果汇总或URL提取的全文）",
      },
      sourceBundle: {
        type: "array" as const,
        description: "源内容数组（多条URL或多篇文章）",
        items: {
          type: "object" as const,
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      durationMinutes: {
        type: "number",
        description: "目标播客时长（分钟），用于评估线索完整性",
      },
      focusHint: {
        type: "string",
        description: "用户给出的聚焦提示，若命中则直接采用",
      },
    },
    required: ["sourceText"],
  },
  outputSchema: {
    type: "object",
    properties: {
      selected: { type: "object" },
      contentType: { type: "string" },
      rationale: { type: "string" },
    },
  },
  outputExample: {
    selected: { id: "t1", summary: "示例线索", evidence: "...", argumentSpace: 8 },
    contentType: "rigorous",
    rationale: "聚焦该线索",
  },

  async steps(input) {
    const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
    const sourceText = typeof input.sourceText === "string" ? input.sourceText : "";
    const durationMinutes = typeof input.durationMinutes === "number" ? input.durationMinutes : 30;
    const focusHint = typeof input.focusHint === "string" ? input.focusHint : "";

    await skillNarrate("我先从源内容里聚焦本期主线。");

    // Step 1: 使用 LLM 列举所有可独立撑起一期的线索
    const listStep = await step("列举线索", async (ctx) => {
      await narrate(ctx, `正在分析源内容，找出能撑起 ${durationMinutes} 分钟的线索…`);
      const analysis = await ctx.call<{
        threads: Array<{
          id: string;
          summary: string;
          evidence: string;
          argumentSpace: number;
        }>;
      }>("thought", {
        directive: `分析以下源内容，找出所有"能独立撑起一期${durationMinutes}分钟播客"的线索。

源内容：${sourceText}

对每条线索，输出：
1. id: 唯一标识
2. summary: 一句话总结
3. evidence: 最有说服力的片段（100字以内）
4. argumentSpace: 0-10的评分（能否完整论证）

返回 JSON: { threads: [...] }`,
      });
      return analysis;
    });

    const threads: Thread[] = listStep?.threads || [];

    if (threads.length === 0) {
      throw new Error("未找到任何可独立成篇的线索，请补充内容或调整关键词");
    }

    await skillNarrate(`找到 ${threads.length} 条候选线索。`);

    // Step 2: 判定数量，决定是直接选还是需要反问
    let selected: Thread;
    let discarded: Thread[] = [];

    if (threads.length === 1) {
      await skillNarrate("只有 1 条候选线索，直接采用。");
      selected = threads[0]!;
    } else if (focusHint) {
      // 用户提示命中
      selected = threads.find((t) => t.summary.includes(focusHint)) || threads[0]!;
      discarded = threads.filter((t) => t.id !== selected.id);
      await skillNarrate(`用户提示命中：${selected.summary}。`);
    } else {
      // 需要用户选择：用 requireConfirmation 的 options 传线索摘要，params.choice 传回选中 id
      await skillNarrate(`发现 ${threads.length} 条独立线索，需要你选一条。`);
      const choiceStep = await step<{ choice?: string } | undefined>("请用户选择线索", async (ctx) => {
        const result = await ctx.requireConfirmation({
          prompt: `发现 ${threads.length} 条独立线索，请选择一条作为本期核心：\n${threads
            .map((t, i) => `${i + 1}. ${t.summary} (论证空间: ${t.argumentSpace}/10)`)
            .join("\n")}`,
          options: threads.map((t) => t.summary),
          detail: { threadIds: threads.map((t) => t.id) },
        });
        // approved=false 表示用户未明确选择，降级取第一个
        if (!result.approved) return { choice: threads[0]!.id } as { choice?: string };
        const chosen = typeof result.params?.choice === "string" ? result.params.choice : threads[0]!.id;
        return { choice: chosen };
      });

      const selectedId = choiceStep?.choice ?? threads[0]!.id;
      selected = threads.find((t) => t.id === selectedId) || threads[0]!;
      discarded = threads.filter((t) => t.id !== selected.id);
    }

    // Step 3: 推断内容类型
    const typeStep = await step("判断内容类型", async (ctx) => {
      await narrate(ctx, "正在判断内容类型（严谨型 vs 综合型）…");
      const result = await ctx.call<{ contentType: string }>("thought", {
        directive: `根据以下线索特征，判断是"rigorous"(严谨型阐述)还是"comprehensive"(综合型分析)：

线索: ${selected.summary}
证据: ${selected.evidence}
论证空间: ${selected.argumentSpace}/10

返回 JSON: { contentType: "rigorous" | "comprehensive" }`,
      });
      return result;
    });

    const contentType: "rigorous" | "comprehensive" =
      typeStep?.contentType === "rigorous" ? "rigorous" : "comprehensive";

    await skillNarrate(
      `判定内容类型：${contentType === "rigorous" ? "严谨型" : "综合型"}。`,
    );

    const rationale = `聚焦线索"${selected.summary}"（论证空间 ${selected.argumentSpace}/10），内容类型为${contentType === "rigorous" ? "严谨型" : "综合型"}。${discarded.length > 0 ? `并弃置 ${discarded.length} 条线索。` : ""}`;

    await skillSummary(
      `已聚焦：${selected.summary}（论证空间 ${selected.argumentSpace}/10），内容类型为${contentType === "rigorous" ? "严谨型" : "综合型"}。`,
    );

    const evidence = wrapEvidence(
      {
        selectedThread: selected.id,
        threadCount: threads.length,
        contentType,
      },
      {
        freshness: "realtime",
        confidence: "inferred",
        system: "llm",
        provenance: "skill.thread_focuser",
      },
    );

    const output: ThreadFocuserOutput = {
      selected,
      discarded,
      contentType,
      rationale,
      evidence,
    };

    return output;
  },
});
