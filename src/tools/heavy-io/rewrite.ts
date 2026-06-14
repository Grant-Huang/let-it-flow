import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateText } from "ai";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import {
  toolCallPayload,
  toolResultPayload,
  textPayload,
} from "../../core/stream-events.js";
import type { SubprocessAdapter } from "./subprocess-adapter.js";
import type { LlmService } from "../../services/llm-service.js";
import { DEFAULT_OLLAMA_REWRITE_MODEL } from "./provider.js";

/**
 * Rewrite 工具（step3，见 09 P5）。
 * 把翻译稿改写成播客旁述文稿。两种后端可配（config.rewriteBackend）：
 *   - ollama（默认）：调 run_step.py 3 → run_35b_rewrite.py（本地 35B，质量好）
 *   - openai：直连 LlmService（快，需 key）
 *
 * 输入：上游 translate 的译稿（写入 workDir/scripts/translated.txt）。
 * 产出：workDir/scripts/script_v2_raw.txt（ollama）；output.script（openai）。
 */
const inputSchema = z.object({
  /** 上游 translate 译稿（executor 注入）。 */
  translatedText: z.string().describe("待改写的译稿"),
  /** rewrite 形式（透传 system prompt）。 */
  style: z.enum(["dialogue", "narration", "summary"]).default("dialogue"),
  /** 目标语言。 */
  language: z.string().default("zh"),
  /** 额外指令。 */
  hint: z.string().optional(),
});

export interface RewriteOutput {
  script: string;
  backend: "ollama" | "openai";
}

export interface RewriteToolDeps {
  adapter: SubprocessAdapter;
  llm: LlmService;
  backend?: "ollama" | "openai";
  ollamaModel?: string;
}

export function createRewriteTool(deps: RewriteToolDeps): FlowConnector<RewriteOutput> {
  const backend = deps.backend ?? "ollama";
  const ollamaModel = deps.ollamaModel ?? DEFAULT_OLLAMA_REWRITE_MODEL;
  return {
    name: "domain.rewrite",
    tier: "domain",
    description: "播客改写（step3）：把译稿改写成播客旁述文稿。支持本地 35B（ollama）与 OpenAI。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<RewriteOutput>> {
      const args = inputSchema.parse(params);
      const workDir = deps.adapter.workDirOf(ctx.taskId);
      await deps.adapter.ensureWorkDir(workDir);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.rewrite",
          args: { backend, style: args.style, textLen: args.translatedText.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "rewrite",
        }),
      };

      let script: string;
      if (backend === "ollama") {
        script = await runOllamaRewrite(deps.adapter, workDir, args, ctx, ollamaModel);
      } else {
        script = await runOpenaiRewrite(deps.llm, args, ctx);
      }

      const output: RewriteOutput = { script, backend };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: script.length > 0, scriptLen: script.length }),
        }),
      };
      return { output, summary: `改写完成（${backend}）→ ${script.length} 字` };
    },
  };
}

/** ollama 路径：写译稿 → run_step 3 → 读 script_v2_raw.txt。 */
async function runOllamaRewrite(
  adapter: SubprocessAdapter,
  workDir: string,
  args: z.infer<typeof inputSchema>,
  ctx: { emit: (e: ToolEvent) => Promise<unknown> },
  ollamaModel: string,
): Promise<string> {
  // ai-content-factory step3 读 scripts/translated.txt（step2 产物名）
  await adapter.writeScript(workDir, "translated.txt", args.translatedText);
  // 透传 ollama 模型名给 Python 脚本（供将来 run_35b_rewrite.py 读取覆盖 MODEL_35B）
  const res = await adapter.runStep("3", workDir, {
    timeoutMs: 900_000,
    extraEnv: { LIF_OLLAMA_MODEL: ollamaModel },
  });
  if (!res.ok) {
    await ctx.emit({ type: "text", channel: "content", payload: textPayload(`改写失败：${res.stderr.slice(-200)}`) });
    return "";
  }
  const out = await adapter.readScript(workDir, "script_v2_raw.txt");
  return out ?? "";
}

/** openai 路径：直连 LlmService streamText 生成。 */
async function runOpenaiRewrite(
  llm: LlmService,
  args: z.infer<typeof inputSchema>,
  ctx: { emit: (e: ToolEvent) => Promise<unknown> },
): Promise<string> {
  const model = llm.model("writer");
  const styleGuide: Record<string, string> = {
    dialogue: "改写成两人对谈式播客（A/B 轮流发言）。",
    narration: "改写成第三方转述的叙述体旁述。",
    summary: "改写成客观的要点总结。",
  };
  const system = [
    `目标语言：${args.language}。`,
    styleGuide[args.style] ?? styleGuide.dialogue,
    args.hint ? `额外要求：${args.hint}` : "",
  ].join("\n");

  try {
    const { text } = await generateText({
      model,
      system,
      prompt: args.translatedText,
      temperature: 0.7,
    });
    return text;
  } catch (e) {
    await ctx.emit({
      type: "text",
      channel: "content",
      payload: textPayload(`改写失败：${e instanceof Error ? e.message : String(e)}`),
    });
    return "";
  }
}
