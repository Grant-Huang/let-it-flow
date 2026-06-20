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
 * 单句长度校验工具（podcast-generator 改进 #4）。
 *
 * 用于在 rewrite 之后校验单句长度：
 *   - 单句 ≤ 25 字
 *   - 超长句子自动调 LLM 拆分重写
 *
 * 输入：rewrite 输出的脚本。
 * 产出：校验通过的脚本（必要时已重写）。
 */
const inputSchema = z.object({
  script: z.string().describe("待校验的播客脚本"),
  maxSentenceLength: z.number().int().positive().default(25).describe("单句最大字数"),
});

export interface SentenceValidatorOutput {
  script: string;
  passed: boolean;
  violationsBefore: number;
  violationsAfter: number;
  revised: boolean;
}

export interface SentenceValidatorDeps {
  llm: LlmService;
}

/** 切分中文句子（按 。！？；\n 分割）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/([。！？；\n])/)
    .reduce<string[]>((acc, cur, i, arr) => {
      if (i % 2 === 0) {
        const next = arr[i + 1] ?? "";
        const combined = (cur + next).trim();
        if (combined.length > 0) acc.push(combined);
      }
      return acc;
    }, []);
}

function findViolations(script: string, maxLen: number): Array<{ index: number; text: string; length: number }> {
  const sentences = splitSentences(script);
  return sentences
    .map((text, index) => ({ index, text, length: text.replace(/[。！？；\s]/g, "").length }))
    .filter((s) => s.length > maxLen);
}

export function createSentenceValidatorTool(deps: SentenceValidatorDeps): FlowConnector<SentenceValidatorOutput> {
  return {
    name: "domain.sentence_validator",
    tier: "domain",
    description: "单句长度校验（≤25字铁律），自动拆分重写超长句",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["单句长度校验", "口播稿短句化", "句长铁律", "拆分长句"],
      notFor: ["术语统一（走 terminology）", "接缝修复（走 seam_repair）"],
    },
    outputSchema: {
      type: "object",
      description: "校验结果与修订后脚本",
      properties: {
        script: { type: "string", description: "通过校验的脚本" },
        passed: { type: "boolean", description: "是否首次通过" },
        violationsBefore: { type: "number", description: "原始违例数" },
        violationsAfter: { type: "number", description: "修订后违例数" },
        revised: { type: "boolean", description: "是否经过自动重写" },
      },
    },
    outputExample: { script: "短句化后的脚本", passed: true, violationsBefore: 0, violationsAfter: 0, revised: false },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<SentenceValidatorOutput>> {
      const args = inputSchema.parse(params);
      const callId = `c_${randomUUID().slice(0, 8)}`;

      const violationsBefore = findViolations(args.script, args.maxSentenceLength);

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.sentence_validator",
          args: { scriptLen: args.script.length, maxSentenceLength: args.maxSentenceLength, violationsFound: violationsBefore.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "validation",
        }),
      };

      let finalScript = args.script;
      let revised = false;
      let violationsAfter = violationsBefore.length;

      if (violationsBefore.length > 0) {
        // 调 LLM 拆分重写
        const model = deps.llm.model("rewrite");
        const longSentences = violationsBefore.map((v) => v.text).join("\n");
        const prompt = `以下是超过 ${args.maxSentenceLength} 字的长句，请把每一句拆成多个 ≤ ${args.maxSentenceLength} 字的短句，保持原意，使用顺承连词（如"而且"、"然后"、"所以"）衔接。只输出拆分后的句子，每行一句。

原长句：
${longSentences}

拆分后：`;

        const { text } = await generateText({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
        } as never);

        // 将重写后的句子拼接回脚本（简单替换：把原长句替换为新句子）
        let revisedScript = args.script;
        const revisedLines = text.split("\n").filter((l: string) => l.trim().length > 0);
        let lineIdx = 0;
        for (const violation of violationsBefore) {
          const replacement = revisedLines[lineIdx];
          if (replacement !== undefined) {
            revisedScript = revisedScript.replace(violation.text, replacement);
            lineIdx++;
          }
        }

        finalScript = revisedScript;
        revised = true;
        violationsAfter = findViolations(finalScript, args.maxSentenceLength).length;
      }

      const output: SentenceValidatorOutput = {
        script: finalScript,
        passed: violationsBefore.length === 0,
        violationsBefore: violationsBefore.length,
        violationsAfter,
        revised,
      };

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, ...output, scriptLen: finalScript.length }),
        }),
      };

      return {
        output,
        summary: `句长校验完成：原违例 ${violationsBefore.length} 条，修订后 ${violationsAfter} 条${revised ? "（已自动重写）" : ""}`,
      };
    },
  };
}
