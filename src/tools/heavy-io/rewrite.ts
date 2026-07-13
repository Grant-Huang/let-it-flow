import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import {
  toolCallPayload,
  toolResultPayload,
  textPayload,
} from "../../core/stream-events.js";
import { getHeavyIoTimeoutMs } from "../../core/system-settings.js";
import type { RewriteRuntime } from "./runtime-interfaces.js";
import type { LlmService } from "../../services/llm-service.js";
import { getDefaultOllamaRewriteModel } from "./provider.js";
import { tracedGenerateText } from "../../llm/call-tracer.js";
import type { LlmCallEvent } from "../../llm/call-log.js";
import { resolveCallSiteParams } from "../../llm/llm-config.js";

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
  runtime: RewriteRuntime;
  llm: LlmService;
  backend?: "ollama" | "openai";
  ollamaModel?: string;
  /** openai 路径用的模型 id（如 deepseek-v4-flash）；不指定则用 writer 角色。 */
  openaiModel?: string;
}

export function createRewriteTool(deps: RewriteToolDeps): FlowConnector<RewriteOutput> {
  const backend = deps.backend ?? "ollama";
  const ollamaModel = deps.ollamaModel ?? getDefaultOllamaRewriteModel();
  return {
    name: "domain.rewrite",
    tier: "domain",
    description: "播客改写（step3）：把译稿改写成播客旁述文稿。支持本地 35B（ollama）与 OpenAI。",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["播客改写", "译稿转旁述", "对话/叙述/摘要风格", "step3 改写"],
      notFor: ["翻译（走 translate）", "通用 LLM 生成（走 llm_node）"],
    },
    outputSchema: {
      type: "object",
      description: "改写后的播客文稿",
      properties: { script: { type: "string", description: "改写后的旁述文稿" } },
    },
    outputExample: { script: "改写后的播客旁述文稿..." },
    selfEmitEvents: true,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<RewriteOutput>> {
      const args = inputSchema.parse(params);
      const workDir = deps.runtime.workDirOf(ctx.taskId);
      await deps.runtime.ensureWorkDir(workDir);

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
        script = await runOllamaRewrite(deps.runtime, workDir, args, ctx, ollamaModel);
      } else {
        script = await runOpenaiRewrite(deps.llm, args, ctx, deps.openaiModel);
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
  runtime: RewriteRuntime,
  workDir: string,
  args: z.infer<typeof inputSchema>,
  ctx: { emit: (e: ToolEvent) => Promise<unknown> },
  ollamaModel: string,
): Promise<string> {
  // ai-content-factory step3 读 scripts/translated.txt（step2 产物名）
  await runtime.writeScript(workDir, "translated.txt", args.translatedText);
  // 透传 ollama 模型名给 Python 脚本（供将来 run_35b_rewrite.py 读取覆盖 MODEL_35B）
  const res = await runtime.runStep("3", workDir, {
    timeoutMs: getHeavyIoTimeoutMs(),
    extraEnv: { LIF_OLLAMA_MODEL: ollamaModel },
  });
  if (!res.ok) {
    await ctx.emit({ type: "text", channel: "content", payload: textPayload(`改写失败：${res.stderr.slice(-200)}`) });
    return "";
  }
  const out = await runtime.readScript(workDir, "script_v2_raw.txt");
  return out ?? "";
}

/** openai 路径：直连 LlmService（P8.3 改走 callSite=rewrite 统一解析 + tracedGenerateText 埋点）。 */
async function runOpenaiRewrite(
  llm: LlmService,
  args: z.infer<typeof inputSchema>,
  ctx: { emit: (e: ToolEvent) => Promise<unknown>; taskId: string; nodeId?: string },
  openaiModel?: string,
  onLlmCall?: (event: LlmCallEvent) => void,
): Promise<string> {
  // P8.3：优先用 callSite=rewrite 解析（走两层配置体系）；
  // 若显式指定了 openaiModel（向后兼容），则用具体模型绕过配置
  const model = openaiModel ? llm.modelById(openaiModel) : llm.model("rewrite");
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
    // P8.5：compatMode + provider + pricing 全部从 endpoint 读（per-callSite）
    const ep = llm.resolveEndpoint("rewrite");
    const rewriteTemp = resolveCallSiteParams("rewrite").temperature;
    const { text } = await tracedGenerateText(
      model,
      llm.compatModeFor("rewrite")
        ? { prompt: `${system}\n\n---\n${args.translatedText}`, temperature: rewriteTemp }
        : { system, prompt: args.translatedText, temperature: rewriteTemp },
      {
        callSite: "rewrite",
        modelAlias: openaiModel ?? ep?.alias ?? "rewrite",
        provider: ep?.provider ?? "openai",
        ...(ep?.pricing ? { pricing: ep.pricing } : {}),
        taskId: ctx.taskId,
        nodeId: ctx.nodeId,
        params: { temperature: rewriteTemp },
      },
      onLlmCall ?? (() => {}),
    );
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
