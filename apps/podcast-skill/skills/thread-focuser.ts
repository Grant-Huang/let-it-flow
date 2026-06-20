import { createSkill } from "../../../src/agent/skill-bridge.js";
import type { EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

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
  evidence: EvidenceEnvelope;
}

export const threadFocuserSkill = createSkill({
  name: "skill.thread_focuser",
  description: "从多条内容线索中聚焦出单一主线索，判定内容类型（严谨型 vs 综合型）",
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

  async steps(input) {
    const { step } = input;

    // Step 1: 使用 LLM 列举所有可独立撑起一期的线索
    const listStep = await step("列举线索", async (ctx) => {
      const analysis = await ctx.call<{
        threads: Array<{
          id: string;
          summary: string;
          evidence: string;
          argumentSpace: number;
        }>;
      }>("thought", {
        // 通过 thought 工具分析源内容，列举线索
        directive: `分析以下源内容，找出所有"能独立撑起一期${input.durationMinutes || 30}分钟播客"的线索。

源内容：${input.sourceText || JSON.stringify(input.sourceBundle)}

对每条线索，输出：
1. id: 唯一标识
2. summary: 一句话总结
3. evidence: 最有说服力的片段（100字以内）
4. argumentSpace: 0-10的评分（能否完整论证）

返回 JSON: { threads: [...] }`,
      });
      return analysis;
    });

    const threads: Thread[] = listStep.threads || [];

    // Step 2: 判定数量，决定是直接选还是需要反问
    let selected: Thread;
    let discarded: Thread[] = [];

    if (threads.length === 0) {
      throw new Error("未找到任何可独立成篇的线索，请补充内容或调整关键词");
    }

    if (threads.length === 1) {
      selected = threads[0];
    } else {
      // 多条线索情况
      if (input.focusHint) {
        // 用户提示命中
        selected = threads.find((t) => t.summary.includes(input.focusHint)) || threads[0];
        discarded = threads.filter((t) => t.id !== selected.id);
      } else {
        // 需要用户选择
        const choiceStep = await step("请用户选择线索", async (ctx) => {
          const choice = await ctx.requireConfirmation({
            prompt: `发现 ${threads.length} 条独立线索，请选择一条作为本期核心：`,
            options: threads.map((t) => ({
              id: t.id,
              label: `${t.summary} (论证空间: ${t.argumentSpace}/10)`,
              preview: t.evidence,
            })),
          });
          return choice;
        });

        const selectedId = (choiceStep as { id: string }).id;
        selected = threads.find((t) => t.id === selectedId) || threads[0];
        discarded = threads.filter((t) => t.id !== selected.id);
      }
    }

    // Step 3: 推断内容类型
    const typeStep = await step("判断内容类型", async (ctx) => {
      const result = await ctx.call<{ contentType: string }>("thought", {
        directive: `根据以下线索特征，判断是"rigorous"(严谨型阐述)还是"comprehensive"(综合型分析)：

线索: ${selected.summary}
证据: ${selected.evidence}
论证空间: ${selected.argumentSpace}/10

返回 JSON: { contentType: "rigorous" | "comprehensive" }`,
      });
      return result;
    });

    const contentType = (typeStep.contentType as "rigorous" | "comprehensive") || "comprehensive";

    const rationale = `聚焦线索"${selected.summary}"（论证空间 ${selected.argumentSpace}/10），内容类型为${contentType === "rigorous" ? "严谨型" : "综合型"}。${discarded.length > 0 ? `并弃置 ${discarded.length} 条线索。` : ""}`;

    const output: ThreadFocuserOutput = {
      selected,
      discarded,
      contentType,
      rationale,
      evidence: {
        provenance: "skill.thread_focuser",
        confidence: "reasoned",
        freshness: new Date().toISOString(),
        data: {
          selectedThread: selected.id,
          threadCount: threads.length,
          contentType,
        },
      },
    };

    return output;
  },
});
