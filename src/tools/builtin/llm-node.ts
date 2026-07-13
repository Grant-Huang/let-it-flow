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

export type RewriteStyle = "dialogue" | "narration" | "summary";

const inputSchema = z.object({
  prompt: z.string().min(1).describe("用户 prompt / 指令"),
  systemPrompt: z.string().optional().describe("系统提示词；与 style 模板拼接"),
  /**
   * 由 executor 从 inputRefs 解析注入的上游正文。
   * 支持字符串（直接拼入）或结构化数据（数组/对象 → 序列化为可读文本），
   * 让上游 web_fetch 的 FetchedDoc[] 等数组形态可被直接消费，无需中间转换节点。
   */
  context: z.union([z.string(), z.array(z.unknown()), z.record(z.unknown())]).optional().describe("上游节点输出经 Content Pipeline 压缩后的正文（字符串或结构化数据）"),
  style: z.enum(["dialogue", "narration", "summary"]).optional().describe("rewrite 形式（podcast）"),
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
    selfEmitEvents: true,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<string>> {
      const args = inputSchema.parse(params);
      // role → callSite，优先走 callSite 路径（命中 registry 绑定，含 DeepSeek 等兼容服务）；
      // 仅当显式指定 model id 时才绕过（调试场景）。这样避免 legacy role 体系在配置了
      // openai-compatible endpoint 时仍回退到 DEFAULT_MODELS（如 gpt-4o-mini）。
      const callSite = ROLE_TO_CALLSITE[args.role as LlmRole] ?? "rewrite";
      const model = args.model ? opts.llm.modelById(args.model) : opts.llm.model(callSite);
      const foldSystem = opts.llm.compatModeFor(callSite);
      const system = composeSystem(args.systemPrompt, args.style);
      const callId = ctx.callId ?? `c_${randomUUID().slice(0, 8)}`;

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

      return {
        output: full,
        summary: truncatePreview(full, 120),
        narration: `生成完成：${full.length} 字符`,
      };
    },
  };
}

/** 把 style 拼成 systemPrompt 的一部分（P4 模板会提供更完整模板）。 */
function composeSystem(base?: string, style?: RewriteStyle): string | undefined {
  const styleHint: Record<RewriteStyle, string> = {
    dialogue: "以两人对话形式改写（主持人/嘉宾，交替发言）。",
    narration: "以第三方转述的叙述形式改写。",
    summary: "以客观、简洁的要点总结形式改写。",
  };
  const parts = [base, style ? styleHint[style] : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildMessages(
  system: string | undefined,
  prompt: string,
  context?: string | unknown[] | Record<string, unknown>,
  foldSystem = false,
): Array<{ role: "system" | "user"; content: string }> {
  const msgs: Array<{ role: "system" | "user"; content: string }> = [];
  const contextText = serializeContext(context);
  const userContent = contextText ? `${prompt}\n\n---\n素材正文：\n${contextText}` : prompt;
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

/**
 * 把 context（可能是字符串、数组、对象）序列化为可读文本。
 * - 字符串：直接返回
 * - FetchedDoc[] 等数组：按字段拼接成 [n/N] title\ncontent 的可读块
 * - 对象：JSON 序列化（pretty）
 * - undefined/null/空：返回 undefined（不拼入 user 消息）
 */
function serializeContext(
  context?: string | unknown[] | Record<string, unknown>,
): string | undefined {
  if (context === undefined || context === null) return undefined;
  if (typeof context === "string") return context || undefined;
  if (Array.isArray(context)) {
    if (context.length === 0) return undefined;
    // 识别 FetchedDoc 形态（含 url/title/content 字段的对象数组）
    const isDocArray = context.every(
      (item) => item && typeof item === "object" && "content" in (item as object),
    );
    if (isDocArray) {
      return context
        .map((item, i) => {
          const doc = item as { url?: string; title?: string; content?: string; error?: string };
          const header = `[${i + 1}/${context.length}] ${doc.title ?? doc.url ?? ""}`;
          const body = doc.error ? `(抓取失败：${doc.error})` : doc.content ?? "";
          return `${header}\n${body}`;
        })
        .join("\n\n---\n\n");
    }
    // 通用数组：JSON 序列化
    return JSON.stringify(context, null, 2);
  }
  // 对象：JSON 序列化
  const s = JSON.stringify(context, null, 2);
  return s === "{}" ? undefined : s;
}

function truncatePreview(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
