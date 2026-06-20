import { z } from "zod";
import { streamText } from "ai";
import type { FlowConnector, ToolResult } from "../base.js";
import type { LlmService, LlmRole } from "../../services/llm-service.js";
import type { CallSite } from "../../llm/call-sites.js";
import { textPayload, toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { randomUUID } from "node:crypto";

/**
 * llm_node —— LLM 生成节点（见 04 §4.4，podcast MVP 的 rewrite/translate/synthesize 实例）。
 *
 * 用 AI SDK streamText 流式产出 text 事件（增量 delta），供前端 StreamingCursor 渲染。
 * rewrite 形式参数化（见计划"关键设计 2"）：params.style 作为 systemPrompt 的一部分传入，
 * P4 的 podcast 模板只需定义 dialogue/narration/summary 三种 style 的 prompt 模板。
 *
 * 输入（params）：
 *   - prompt / systemPrompt：直接文本
 *   - inputRefs 解析后的正文：由 executor 注入到 params.context（字符串）
 *   - style：rewrite 形式（dialogue/narration/summary），拼入 systemPrompt
 *   - role：LLM 角色（writer/summarizer/...），决定用哪个模型
 *   - model：直接指定模型 id（覆盖 role）
 */

// 新增 briefing / dual_line 见 podcast-generator 改进 #2
export type RewriteStyle = "dialogue" | "narration" | "summary" | "briefing" | "dual_line";

const inputSchema = z.object({
  prompt: z.string().min(1).describe("用户 prompt / 指令"),
  systemPrompt: z.string().optional().describe("系统提示词；与 style 模板拼接"),
  /** 由 executor 从 inputRefs 解析注入的上游正文（字符串）。 */
  context: z.string().optional().describe("上游节点输出经 Content Pipeline 压缩后的正文"),
  style: z.enum(["dialogue", "narration", "summary", "briefing", "dual_line"]).optional().describe("rewrite 形式（podcast）"),
  role: z.enum(["planner", "writer", "summarizer", "default"]).optional().default("writer"),
  model: z.string().optional().describe("直接指定模型 id（覆盖 role）"),
  /** 生成温度等透传给 streamText。 */
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export interface LlmNodeToolOptions {
  llm: LlmService;
}

export function createLlmNodeTool(opts: LlmNodeToolOptions): FlowConnector<string> {
  /** role → callSite 映射，用于 per-callSite compatMode 查询。 */
  const ROLE_TO_CALLSITE: Record<LlmRole, CallSite> = {
    planner: "planner",
    writer: "rewrite",
    summarizer: "rewrite",
    default: "rewrite",
  };
  return {
    name: "core.llm_node",
    tier: "core",
    description:
      "LLM 生成节点：streamText 流式产出 text。rewrite 形式经 params.style 拼入 systemPrompt（dialogue/narration/summary）。",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["文本改写", "总结", "翻译", "扩写", "摘要生成", "播客文稿生成", "通用 LLM 生成"],
      notFor: ["需要外部检索（先 web_search/web_fetch）", "交付产物（走 deliver）", "TTS/生图/视频（用 domain 工具）"],
    },
    outputSchema: {
      type: "object",
      description: "LLM 生成的文本（字符串）",
      properties: {
        text: { type: "string", description: "完整生成文本，下游节点可经 inputRefs 引用" },
      },
    },
    outputExample: { text: "生成的播客文稿内容..." },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<string>> {
      const args = inputSchema.parse(params);
      const model = args.model ? opts.llm.modelById(args.model) : opts.llm.model(args.role as LlmRole);
      // P8.5：compatMode 按 role 对应的 callSite 解析（per-callSite）
      const callSite = ROLE_TO_CALLSITE[args.role as LlmRole] ?? "rewrite";
      const foldSystem = opts.llm.compatModeFor(callSite);
      const system = composeSystem(args.systemPrompt, args.style);
      const callId = `c_${randomUUID().slice(0, 8)}`;

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "core.llm_node",
          args: { style: args.style ?? "default", role: args.role, hasContext: !!args.context },
          risk: "safe",
          groupId: ctx.nodeId,
        }),
      };

      const messages = buildMessages(system, args.prompt, args.context, foldSystem);
      const result = streamText({
        model,
        messages,
        temperature: args.temperature,
        ...(args.maxOutputTokens ? { maxOutputTokens: args.maxOutputTokens } : {}),
      });

      let full = "";
      const t0 = Date.now();
      try {
        for await (const delta of result.textStream) {
          full += delta;
          yield { type: "text", channel: "content", payload: textPayload(delta) };
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({ tool_call_id: callId, output: full, error: errMsg, duration_ms: Date.now() - t0 }),
        };
        throw e;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: full, duration_ms: Date.now() - t0 }),
      };

      return { output: full, summary: truncatePreview(full, 120) };
    },
  };
}

/** 把 style 拼成 systemPrompt 的一部分（P4 模板会提供更完整模板）。 */
function composeSystem(base?: string, style?: RewriteStyle): string | undefined {
  const styleHint: Record<RewriteStyle, string> = {
    dialogue: "以两人对话形式改写（主持人/嘉宾，交替发言）。",
    narration: "以第三方转述的叙述形式改写。",
    summary: "以客观、简洁的要点总结形式改写。",
    briefing: "以简报体改写：开场列 3-5 条热点 → 深度展开 2 条 → 趋势观察 → 收尾预告。",
    dual_line: "以双线对照体改写：抛出对立观点 → 各自论据 → 交叉对比 → 综合判断。",
  };
  const parts = [base, style ? styleHint[style] : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildMessages(
  system: string | undefined,
  prompt: string,
  context?: string,
  foldSystem = false,
): Array<{ role: "system" | "user"; content: string }> {
  const msgs: Array<{ role: "system" | "user"; content: string }> = [];
  const userContent = context ? `${prompt}\n\n---\n素材正文：\n${context}` : prompt;
  if (system && !foldSystem) {
    msgs.push({ role: "system", content: system });
    msgs.push({ role: "user", content: userContent });
  } else if (system && foldSystem) {
    // 兼容模式（DeepSeek 等）：SDK 会把 system 映射成不支持的 `developer` 角色，
    // 故把指令折叠进 user 消息开头。
    msgs.push({ role: "user", content: `${system}\n\n---\n${userContent}` });
  } else {
    msgs.push({ role: "user", content: userContent });
  }
  return msgs;
}

function truncatePreview(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
