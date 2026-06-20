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
 * 线索聚焦工具（podcast-generator 改进 #1）。
 *
 * 输入：fetch 抓取的多文档（FetchedDoc[]）。
 * 输出：聚焦后的单条主线索 + 弃置说明 + contentType 推断。
 *
 * 规则：
 *   - 单文档 → 直接选中，rationale 说明聚焦点
 *   - 多文档无 focusHint → 选论证空间最大的，记录弃置
 *   - 多文档有 focusHint → 用提示匹配，匹配失败回退到论证空间最大
 */
const inputSchema = z.object({
  sourceBundle: z.array(z.object({
    content: z.string(),
    title: z.string().optional(),
    url: z.string().optional(),
  })).describe("待聚焦的多文档"),
  focusHint: z.string().optional().describe("用户提供的聚焦提示"),
  durationMinutes: z.number().int().positive().default(30).describe("目标播客时长（分钟）"),
});

export interface ThreadFocuserOutput {
  selected: { id: string; summary: string; content: string; argumentSpace: number };
  discarded: Array<{ id: string; summary: string; reason: string }>;
  contentType: "rigorous" | "comprehensive";
  rationale: string;
}

export interface ThreadFocuserDeps {
  llm: LlmService;
}

export function createThreadFocuserTool(deps: ThreadFocuserDeps): FlowConnector<ThreadFocuserOutput> {
  return {
    name: "domain.thread_focuser",
    tier: "domain",
    description: "线索聚焦：从多源素材中聚焦单一主线索，推断内容类型（严谨型/综合型）",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["多源聚焦", "选取主线索", "弃置无关材料", "内容类型判定"],
      notFor: ["单文档处理（直接 rewrite）", "翻译（走 translate）"],
    },
    outputSchema: {
      type: "object",
      description: "聚焦结果",
      properties: {
        selected: { type: "object" },
        discarded: { type: "array" },
        contentType: { type: "string" },
        rationale: { type: "string" },
      },
    },
    outputExample: {
      selected: { id: "doc-0", summary: "AI agent 架构争议", content: "...", argumentSpace: 8 },
      discarded: [],
      contentType: "comprehensive",
      rationale: "唯一文档，论证空间充足",
    },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<ThreadFocuserOutput>> {
      const args = inputSchema.parse(params);
      const callId = `c_${randomUUID().slice(0, 8)}`;

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.thread_focuser",
          args: { docCount: args.sourceBundle.length, hint: args.focusHint ?? "" },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "focus",
        }),
      };

      // 单文档：直接选中
      if (args.sourceBundle.length === 1) {
        const doc = args.sourceBundle[0]!;
        const output: ThreadFocuserOutput = {
          selected: {
            id: "doc-0",
            summary: doc.title || doc.content.slice(0, 80),
            content: doc.content,
            argumentSpace: 7,
          },
          discarded: [],
          contentType: doc.content.length > 8000 ? "rigorous" : "comprehensive",
          rationale: "单一文档，直接作为主线索",
        };
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({
            tool_call_id: callId,
            output: JSON.stringify({ ok: true, selected: "doc-0", discarded: 0 }),
          }),
        };
        return { output, summary: "单文档聚焦完成" };
      }

      // 多文档：调 LLM 评估每个的论证空间
      const model = deps.llm.model("planner");
      const docSummary = args.sourceBundle.map((d, i) => `[doc-${i}] ${d.title || ""}\n${d.content.slice(0, 500)}`).join("\n\n---\n\n");
      const prompt = `以下是 ${args.sourceBundle.length} 个候选素材。请评估每个素材"能否独立撑起一期 ${args.durationMinutes} 分钟播客"，并选出最佳主线索。

${args.focusHint ? `用户聚焦提示：${args.focusHint}\n` : ""}
素材：
${docSummary}

返回 JSON 格式：
{
  "selectedId": "doc-X",
  "argumentSpace": 0-10,
  "contentType": "rigorous" 或 "comprehensive",
  "rationale": "选择理由",
  "discarded": [{"id": "doc-Y", "summary": "...", "reason": "..."}]
}`;

      const { text } = await generateText({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      } as never);

      // 解析 LLM 输出（容错）
      let parsed: { selectedId?: string; argumentSpace?: number; contentType?: string; rationale?: string; discarded?: Array<{ id: string; summary: string; reason: string }> } = {};
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        // 解析失败：回退到第一个文档
      }

      const selectedId = parsed.selectedId || "doc-0";
      const selectedIdx = parseInt(selectedId.replace("doc-", ""), 10);
      const selectedDoc = args.sourceBundle[selectedIdx] ?? args.sourceBundle[0]!;

      const output: ThreadFocuserOutput = {
        selected: {
          id: selectedId,
          summary: selectedDoc.title || selectedDoc.content.slice(0, 80),
          content: selectedDoc.content,
          argumentSpace: parsed.argumentSpace || 7,
        },
        discarded: parsed.discarded || args.sourceBundle
          .map((_, i) => i)
          .filter((i) => `doc-${i}` !== selectedId)
          .map((i) => ({ id: `doc-${i}`, summary: args.sourceBundle[i]?.title || "", reason: "未选中" })),
        contentType: (parsed.contentType as "rigorous" | "comprehensive") || "comprehensive",
        rationale: parsed.rationale || "LLM 自动选择最佳主线索",
      };

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, selected: selectedId, discarded: output.discarded.length, contentType: output.contentType }),
        }),
      };

      return {
        output,
        summary: `线索聚焦完成：选定 ${selectedId}（${output.contentType}型），弃置 ${output.discarded.length} 条`,
      };
    },
  };
}
