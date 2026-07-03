import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import { getHeavyIoTimeoutMs } from "../../core/system-settings.js";
import type { TextStepRuntime, SubtitleRuntime, ImagePromptsRuntime } from "../heavy-io/runtime-interfaces.js";
import type { LlmService } from "../../services/llm-service.js";
import type { CallSite } from "../../llm/call-sites.js";
import { tracedGenerateText } from "../../llm/call-tracer.js";
import type { TraceContext } from "../../llm/call-tracer.js";
import type { LlmCallEvent } from "../../llm/call-log.js";
import { resolveCallSiteParams } from "../../llm/llm-config.js";

/** TS 直连路径下 prompt 文件所在目录。 */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "heavy-io", "prompts");

/**
 * P8.5：从 LlmService 的 registry 解析某调用点的 provider/pricing，
 * 构造 tracedGenerateText 的 TraceContext（打通成本统计 + 真实 provider 上报）。
 * 未命中 registry 时回退 provider="ts-direct"（向后兼容）。
 */
function traceCtxFor(
  llm: LlmService,
  callSite: CallSite,
  taskId: string,
): Pick<TraceContext, "callSite" | "modelAlias" | "provider" | "pricing" | "taskId"> {
  const ep = llm.resolveEndpoint(callSite);
  return {
    callSite,
    modelAlias: ep?.alias ?? callSite,
    provider: ep?.provider ?? "ts-direct",
    ...(ep?.pricing ? { pricing: ep.pricing } : {}),
    taskId,
  };
}

/** 加载 prompt 文件（逐字移植自 ai-content-factory/pipeline_steps.py）。 */
function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

/**
 * 文本类步骤工具（step2/3b/3c/3d，见 09 P5）。
 * 这些步骤经 run_step.py 调度（Ollama 14B/35B），文件中转。
 *
 * 文件约定（ai-content-factory）：
 *   step2  translate:  scripts/original_transcript.txt → script_v1_chunk_NN.txt
 *   step3b seam:       scripts/script_v2_raw.txt → script_v2_seamed.txt
 *   step3c terminology: scripts/script_v2_seamed.txt → script_v2.txt（权威文本）
 *   step3d image_prompts: scripts/script_v2.txt → scripts/image_prompts.json
 */

/** 通用 step 工具构造器已移除（P8.3 后 translate/seam/terminology 改为独立函数）。 */

/** translate 工具选项（P8.3 新增 TS 直连支持）。 */
export interface TranslateToolOptions {
  /** P8.3：注入 LlmService 后启用 TS 直连路径。 */
  llm?: LlmService;
  /** 后端切换：ts=TS 直连 LLM；python=子进程（默认）。 */
  backend?: "ts" | "python";
  /** tracing 回调（落库用）。 */
  onLlmCall?: (event: LlmCallEvent) => void;
}

/**
 * step2 翻译。
 *
 * P8.3：支持 backend="ts" 走 TS 直连 LLM（默认 python 向后兼容）。
 * TS 路径按 transcript_meta.json 的 has_speaker_info 选 prompt 分支，
 * 按 "\n\n" 分段翻译（与 Python 的 chunk 切分一致）。
 */
export function createTranslateTool(
  runtime: TextStepRuntime,
  opts: TranslateToolOptions = {},
): FlowConnector<{ text: string }> {
  const name = "domain.translate";
  const groupKind = "translate";
  const schema = z.object({ sourceText: z.string().describe("上游文本") });
  const backend = opts.backend ?? "python";
  return {
    name,
    tier: "domain",
    description: "分段初译（step2，Qwen2.5-14B）：把原文稿译成目标语言。",
    inputSchema: schema.shape,
    whenToUse: {
      triggers: ["文稿翻译", "原文转目标语言", "step2 初译"],
      notFor: ["改写（走 rewrite）", "已译稿（走 seam_repair）"],
    },
    outputSchema: {
      type: "object",
      description: "翻译后的文本",
      properties: { text: { type: "string", description: "翻译结果" } },
    },
    outputExample: { text: "翻译后的文本内容..." },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ text: string }>> {
      const args = schema.parse(params);
      const inputText = args.sourceText ?? "";
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);
      await runtime.writeScript(workDir, "original_transcript.txt", inputText);

      // 准备 transcript_meta.json（python 路径必需；ts 路径用于判断 has_speaker_info）
      if (runtime.writeWorkFile) {
        const meta = {
          has_speaker_info: false,
          source_path_type: "B",
          source_type: "web",
          source_url: "",
          audio_path: "",
          language: "en",
          title: "",
          source: "",
          participants: [],
          host: "",
          publish_date: "",
          domain: "",
          keywords: [],
        };
        await runtime.writeWorkFile(workDir, "transcript_meta.json", JSON.stringify(meta, null, 2));
      }

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId, name, args: { inputLen: inputText.length, backend },
          risk: "safe", groupId: ctx.nodeId, groupKind,
        }),
      };

      let text = "";
      let ok = false;
      if (backend === "ts" && opts.llm) {
        const result = await runTranslateTs(inputText, workDir, runtime, opts.llm, ctx.taskId, opts.onLlmCall);
        text = result.text;
        ok = result.ok;
        if (ok) {
          await runtime.writeScript(workDir, "translated.txt", text);
        }
      } else {
        const res = await runtime.runStep("2", workDir, { timeoutMs: getHeavyIoTimeoutMs() });
        // resolveOutput：先 translated.txt，空则拼接 chunk
        if (runtime.listScripts) {
          const single = await runtime.readScript(workDir, "translated.txt");
          if (single && single.trim().length > 0) {
            text = single;
          } else {
            const chunks = await runtime.listScripts(workDir, "script_v1_chunk_*.txt");
            if (chunks.length > 0) {
              const parts: string[] = [];
              for (const c of chunks) {
                const t = await runtime.readScript(workDir, c);
                if (t && t.trim().length > 0) parts.push(t.trim());
              }
              text = parts.join("\n\n");
            }
          }
        } else {
          text = (await runtime.readScript(workDir, "translated.txt")) ?? "";
        }
        ok = res.ok && text.length > 0;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok, len: text.length }),
        }),
      };
      return {
        output: { text },
        summary: `${name} 完成 → ${text.length} 字`,
        narration: `${name}完成：${text.length} 字符`,
      };
    },
  };
}

/**
 * P8.3 TS 直连：按段翻译。
 * prompt 逐字移植自 ai-content-factory/pipeline_steps.py（WITH_SPEAKER / NO_SPEAKER）。
 */
async function runTranslateTs(
  sourceText: string,
  workDir: string,
  runtime: TextStepRuntime,
  llm: LlmService,
  taskId: string,
  onLlmCall?: (event: LlmCallEvent) => void,
): Promise<{ text: string; ok: boolean }> {
  // 读 transcript_meta.json 判断是否有说话人信息
  let hasSpeaker = false;
  if (runtime.readWorkFile) {
    const metaRaw = await runtime.readWorkFile(workDir, "transcript_meta.json");
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw) as { has_speaker_info?: boolean };
        hasSpeaker = meta.has_speaker_info === true;
      } catch {
        // 解析失败默认无说话人
      }
    }
  }
  const promptFile = hasSpeaker ? "translate-with-speaker.md" : "translate-no-speaker.md";
  const systemPrompt = loadPrompt(promptFile);
  // 与 Python 一致：双换行分段
  const paras = sourceText.split("\n\n").map((p) => p.trim()).filter((p) => p.length > 0);
  const translated: string[] = [];
  for (const para of paras) {
    try {
      const { text } = await tracedGenerateText(
        llm.model("translate" as CallSite),
        { system: systemPrompt, prompt: para },
        traceCtxFor(llm, "translate", taskId),
        onLlmCall ?? (() => {}),
      );
      translated.push(text.trim());
    } catch {
      // 单段失败不中断（与 Python 一致）
      translated.push(para);
    }
  }
  const text = translated.join("\n\n");
  return { text, ok: text.length > 0 };
}

/** seam_repair 工具选项（P8.3 新增 TS 直连支持）。 */
export interface SeamRepairToolOptions {
  llm?: LlmService;
  backend?: "ts" | "python";
  onLlmCall?: (event: LlmCallEvent) => void;
}

/**
 * step3b 接缝修复：script_v2_raw.txt → script_v2_seamed.txt。
 *
 * P8.3：支持 backend="ts" 走 TS 直连 LLM。
 * TS 路径复刻 Python seam_repair.py 的三段逻辑：
 *   1. INTRO_SYSTEM 生成引言（需 transcript_meta.json）
 *   2. SEAM_SYSTEM  逐接缝修复（TAIL_LEN=300, HEAD_LEN=300）
 *   3. OUTRO_SYSTEM 生成小结
 */
export function createSeamRepairTool(
  runtime: TextStepRuntime,
  opts: SeamRepairToolOptions = {},
): FlowConnector<{ text: string }> {
  const name = "domain.seam_repair";
  const groupKind = "seam_repair";
  const schema = z.object({ rewriteText: z.string().describe("上游文本") });
  const backend = opts.backend ?? "python";
  return {
    name,
    tier: "domain",
    description: "接缝修复（step3b，35B）：修复相邻段边界的断层/重复/悬空过渡。",
    inputSchema: schema.shape,
    whenToUse: {
      triggers: ["段落边界修复", "接缝处理", "消除断层/重复"],
      notFor: ["原文翻译（走 translate）", "术语统一（走 terminology）"],
    },
    outputSchema: {
      type: "object",
      description: "修复后的连贯文本",
      properties: { text: { type: "string", description: "修复结果" } },
    },
    outputExample: { text: "修复后的连贯文本..." },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ text: string }>> {
      const args = schema.parse(params);
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);
      await runtime.writeScript(workDir, "script_v2_raw.txt", args.rewriteText);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId, name, args: { inputLen: args.rewriteText.length, backend },
          risk: "safe", groupId: ctx.nodeId, groupKind,
        }),
      };

      let text = "";
      let ok = false;
      if (backend === "ts" && opts.llm) {
        const result = await runSeamRepairTs(args.rewriteText, workDir, runtime, opts.llm, ctx.taskId, opts.onLlmCall);
        text = result.text;
        ok = result.ok;
        if (ok) {
          await runtime.writeScript(workDir, "script_v2_seamed.txt", text);
        }
      } else {
        const res = await runtime.runStep("3b", workDir, { timeoutMs: getHeavyIoTimeoutMs() });
        text = (await runtime.readScript(workDir, "script_v2_seamed.txt")) ?? "";
        ok = res.ok && text.length > 0;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok, len: text.length }),
        }),
      };
      return {
        output: { text },
        summary: `${name} 完成 → ${text.length} 字`,
        narration: `${name}完成：${text.length} 字符`,
      };
    },
  };
}

const SEAM_TAIL_LEN = 300;
const SEAM_HEAD_LEN = 300;

/** 从中段抽样，帮助小结把握主线（移植自 Python _outline_snippets）。 */
function outlineSnippets(paras: string[]): string {
  if (paras.length === 0) return "";
  const n = paras.length;
  const parts = [paras[0]!.slice(0, 650)];
  if (n > 2) parts.push(paras[Math.floor(n / 2)]!.slice(0, 650));
  if (n > 1) parts.push(paras[n - 1]!.slice(0, 650));
  return parts.join("\n…\n");
}

/**
 * P8.3 TS 直连：接缝修复三段逻辑。
 * prompt 逐字移植自 ai-content-factory/seam_repair.py（SEAM/INTRO/OUTRO）。
 */
async function runSeamRepairTs(
  rewriteText: string,
  workDir: string,
  runtime: TextStepRuntime,
  llm: LlmService,
  taskId: string,
  onLlmCall?: (event: LlmCallEvent) => void,
): Promise<{ text: string; ok: boolean }> {
  const paras = rewriteText.split("\n\n").map((p) => p.trim()).filter((p) => p.length > 0);
  if (paras.length === 0) return { text: "", ok: false };

  // 读 transcript_meta.json（用于引言的元信息）
  let meta: Record<string, unknown> = {};
  if (runtime.readWorkFile) {
    const metaRaw = await runtime.readWorkFile(workDir, "transcript_meta.json");
    if (metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch { /* 忽略 */ }
    }
  }
  const host = String((meta.host as string) || (meta.show_host as string) || "主持人").trim();
  const srcName = String((meta.source as string) || (meta.podcast as string) || "本期节目").trim();
  const title = String(meta.title ?? "").trim();
  const participants = (meta.participants as unknown[] | string) || (meta.guests as unknown[]) || [];
  const participantsArr = Array.isArray(participants) ? participants : [participants];
  const guestStr = participantsArr.filter(Boolean).map(String).join("、") || "嘉宾";

  // 1. 引言
  const introPrompt = loadPrompt("seam-intro.md");
  const headSnip = paras[0]!.slice(0, 1200);
  const introUser = `【节目元信息】\n来源：${srcName}\n标题（仅供理解主题，勿整句粘贴英文）：${title}\n主持人：${host}\n嘉宾：${guestStr}\n\n【正文开头摘录】\n${headSnip}`;
  let intro = "";
  try {
    const r = await tracedGenerateText(
      llm.model("seam_repair" as CallSite),
      { system: introPrompt, prompt: introUser, temperature: resolveCallSiteParams("seam_repair").temperature },
      traceCtxFor(llm, "seam_repair", taskId),
      onLlmCall ?? (() => {}),
    );
    intro = r.text.trim();
  } catch { /* 失败留空 */ }

  // 2. 逐接缝修复
  const seamPrompt = loadPrompt("seam-repair.md");
  const repaired = [...paras];
  for (let i = 0; i < paras.length - 1; i++) {
    const prevTail = paras[i]!.slice(-SEAM_TAIL_LEN);
    const nextHead = paras[i + 1]!.slice(0, SEAM_HEAD_LEN);
    const user = `接缝 ${i + 1}/${paras.length - 1}：\n\n【上一段结尾】\n...${prevTail}\n\n【下一段开头】\n${nextHead}...\n\n请判断并输出结果。`;
    try {
      const r = await tracedGenerateText(
        llm.model("seam_repair" as CallSite),
        { system: seamPrompt, prompt: user, temperature: resolveCallSiteParams("seam_repair").temperature },
        traceCtxFor(llm, "seam_repair", taskId),
        onLlmCall ?? (() => {}),
      );
      const result = r.text.trim();
      if (!result.startsWith("[OK]") && result.length > 0) {
        // 替换：上一段去尾 + 修复文字 + 下一段去头
        repaired[i] = paras[i]!.slice(0, -SEAM_TAIL_LEN) + result;
        repaired[i + 1] = paras[i + 1]!.slice(SEAM_HEAD_LEN);
      }
    } catch { /* 单接缝失败跳过 */ }
  }
  const bodyText = repaired.join("\n\n");

  // 3. 小结
  const outroPrompt = loadPrompt("seam-outro.md");
  const outline = outlineSnippets(repaired);
  const tailSnip = repaired[repaired.length - 1]!.slice(-1200);
  const outroUser = `【节目元信息】来源=${srcName}；标题=${title}；主持人=${host}；嘉宾=${guestStr}\n\n【全文脉络摘录】\n${outline}\n\n【结尾摘录】\n${tailSnip}`;
  let outro = "";
  try {
    const r = await tracedGenerateText(
      llm.model("seam_repair" as CallSite),
      { system: outroPrompt, prompt: outroUser, temperature: resolveCallSiteParams("seam_repair").temperature },
      traceCtxFor(llm, "seam_repair", taskId),
      onLlmCall ?? (() => {}),
    );
    outro = r.text.trim();
  } catch { /* 失败留空 */ }

  const finalBlocks = [intro, bodyText.trim(), outro].filter((b) => b.length > 0);
  const finalText = finalBlocks.join("\n\n");
  return { text: finalText, ok: finalText.length > 0 };
}

/** terminology 工具选项（P8.3 新增 TS 直连支持）。 */
export interface TerminologyToolOptions {
  llm?: LlmService;
  backend?: "ts" | "python";
  onLlmCall?: (event: LlmCallEvent) => void;
}

/** 长文保护/缩水回退时的最小术语替换（移植自 Python terminology_pass.py）。 */
function minimalTermReplace(text: string): string {
  let r = text;
  r = r.replace(/\bLLM\b/g, "大模型");
  r = r.replace(/\bAI模型\b/g, "大模型");
  r = r.replace(/\bAI\s+Agents?\b/g, "Agent");
  r = r.replace(/\bAgents?\b/g, "Agent");
  return r;
}

/**
 * step3c 术语统一：script_v2_seamed.txt → script_v2.txt（权威文本）。
 *
 * P8.3：支持 backend="ts" 走 TS 直连 LLM。
 * TS 路径复刻 Python terminology_pass.py 的保护逻辑：
 *   - 长文（≥60000 字）跳过 LLM，直接最小替换
 *   - 输出 < 70% 输入长度时判定为缩水，回退最小替换
 */
export function createTerminologyTool(
  runtime: TextStepRuntime,
  opts: TerminologyToolOptions = {},
): FlowConnector<{ text: string }> {
  const name = "domain.terminology";
  const groupKind = "terminology";
  const schema = z.object({ seamedText: z.string().describe("上游文本") });
  const backend = opts.backend ?? "python";
  return {
    name,
    tier: "domain",
    description: "术语统一（step3c，14B）：统一同概念的不同表达，产出权威文本。",
    inputSchema: schema.shape,
    whenToUse: {
      triggers: ["术语统一", "权威文本生成", "同概念表达归一"],
      notFor: ["接缝修复（走 seam_repair）", "生图提示词（走 image_prompts）"],
    },
    outputSchema: {
      type: "object",
      description: "术语统一后的权威文本",
      properties: { text: { type: "string", description: "权威文本" } },
    },
    outputExample: { text: "术语统一的权威文本..." },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ text: string }>> {
      const args = schema.parse(params);
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);
      await runtime.writeScript(workDir, "script_v2_seamed.txt", args.seamedText);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId, name, args: { inputLen: args.seamedText.length, backend },
          risk: "safe", groupId: ctx.nodeId, groupKind,
        }),
      };

      let text = "";
      let ok = false;
      if (backend === "ts" && opts.llm) {
        const result = await runTerminologyTs(args.seamedText, opts.llm, ctx.taskId, opts.onLlmCall);
        text = result.text;
        ok = result.ok;
        if (ok) {
          await runtime.writeScript(workDir, "script_v2.txt", text);
        }
      } else {
        const res = await runtime.runStep("3c", workDir, { timeoutMs: getHeavyIoTimeoutMs() });
        text = (await runtime.readScript(workDir, "script_v2.txt")) ?? "";
        ok = res.ok && text.length > 0;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok, len: text.length }),
        }),
      };
      return {
        output: { text },
        summary: `${name} 完成 → ${text.length} 字`,
        narration: `${name}完成：${text.length} 字符`,
      };
    },
  };
}

/**
 * P8.3 TS 直连：术语统一（含长文保护 + 缩水回退）。
 * prompt 逐字移植自 ai-content-factory/terminology_pass.py（TERM_SYSTEM）。
 */
async function runTerminologyTs(
  seamedText: string,
  llm: LlmService,
  taskId: string,
  onLlmCall?: (event: LlmCallEvent) => void,
): Promise<{ text: string; ok: boolean }> {
  // 长文保护：≥60000 字跳过 LLM，直接最小替换（与 Python 一致）
  if (seamedText.length >= 60_000) {
    return { text: minimalTermReplace(seamedText).trim(), ok: true };
  }
  const systemPrompt = loadPrompt("terminology.md");
  const userPrompt = `请统一以下脚本的术语：\n\n${seamedText}`;
  let raw = "";
  try {
    const r = await tracedGenerateText(
      llm.model("terminology" as CallSite),
      { system: systemPrompt, prompt: userPrompt, temperature: resolveCallSiteParams("terminology").temperature },
      traceCtxFor(llm, "terminology", taskId),
      onLlmCall ?? (() => {}),
    );
    raw = r.text.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  } catch {
    // LLM 失败，回退最小替换
    return { text: minimalTermReplace(seamedText).trim(), ok: true };
  }
  // 缩水保护：输出 < 70% 输入长度，判定为跑偏，回退最小替换
  if (raw.length < Math.floor(seamedText.length * 0.7)) {
    return { text: minimalTermReplace(seamedText).trim(), ok: true };
  }
  return { text: raw, ok: raw.length > 0 };
}

/** step5 字幕对齐（step5，内部含 wav/whisper/align/srt 子步）。 */
export function createSubtitleTool(runtime: SubtitleRuntime): FlowConnector<{ srtPath: string }> {
  const schema = z.object({
    audioPath: z.string().optional().describe("上游 tts 音频路径（校验用）"),
  });
  return {
    name: "domain.subtitle",
    tier: "domain",
    description: "字幕对齐（step5）：配音 → wav → whisper 转录 → 段落对齐 → srt。",
    inputSchema: schema.shape,
    whenToUse: {
      triggers: ["字幕生成", "配音转字幕", "whisper 转录", "段落对齐"],
      notFor: ["生成配音（走 tts）", "视频合成（走 video_build）"],
    },
    outputSchema: {
      type: "object",
      description: "字幕文件路径",
      properties: { srtPath: { type: "string", description: "final.srt 的绝对路径" } },
    },
    outputExample: { srtPath: "/data/tasks/xxx/video/final.srt" },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ srtPath: string }>> {
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.subtitle",
          args: { hasAudio: !!schema.parse(params).audioPath },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "subtitle",
        }),
      };
      const res = await runtime.runStep("5", workDir, { timeoutMs: getHeavyIoTimeoutMs() });
      // step5d 产出 srt；尝试常见路径
      const srt = (await runtime.readScript(workDir, "final.srt")) ?? "";
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: res.ok, hasSrt: srt.length > 0 }),
        }),
      };
      return {
        output: { srtPath: srt ? `${workDir}/scripts/final.srt` : "" },
        summary: "字幕对齐完成",
        narration: "字幕对齐完成",
      };
    },
  };
}

/** image_prompts 工具选项（P8.3 新增 TS 直连支持）。 */
export interface ImagePromptsToolOptions {
  /** P8.3：注入 LlmService 后启用 TS 直连路径。 */
  llm?: LlmService;
  /** 后端切换：ts=TS 直连 LLM；python=子进程（默认）。 */
  backend?: "ts" | "python";
  /** tracing 回调（落库用）。 */
  onLlmCall?: (event: LlmCallEvent) => void;
}

/** step3d 单段 LLM 输出的结构化 schema（P8.3）。 */
const ImagePromptEntry = z.object({
  theme: z.string(),
  image_prompt: z.string(),
  ken_burns: z.enum(["zoom_in", "zoom_out", "pan_right", "pan_left", "tilt_up", "tilt_down"]),
});

/**
 * step3d 图片提示词：script_v2.txt → scripts/image_prompts.json。
 * 这个工具比较特殊：输出是 JSON（供 image_gen 节点消费），而非纯文本。
 *
 * P8.3：支持 backend="ts" 走 TS 直连 LLM（默认 python 向后兼容）。
 */
export function createImagePromptsTool(
  runtime: ImagePromptsRuntime,
  opts: ImagePromptsToolOptions = {},
): FlowConnector<{ plan: string }> {
  const schema = z.object({
    scriptText: z.string().describe("权威文本（script_v2.txt 内容）"),
  });
  const backend = opts.backend ?? "python";
  return {
    name: "domain.image_prompts",
    tier: "domain",
    description: "图片提示词生成（step3d，14B）：按段落生成英文生图提示词 + ken_burns 效果。",
    inputSchema: schema.shape,
    whenToUse: {
      triggers: ["生图提示词", "配图规划", "ken_burns 效果"],
      notFor: ["直接生图（走 image_gen）", "术语统一（走 terminology）"],
    },
    outputSchema: {
      type: "object",
      description: "生图提示词 JSON（供 image_gen 消费）",
      properties: {
        plan: { type: "string", description: "场景清单 JSON 字符串（含 image_path/para_summary）" },
      },
    },
    outputExample: { plan: '[{"image_path":"cover.png","para_summary":"开场场景"}]' },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ plan: string }>> {
      const args = schema.parse(params);
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);
      await runtime.writeScript(workDir, "script_v2.txt", args.scriptText);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.image_prompts",
          args: { scriptLen: args.scriptText.length, backend },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "image_prompts",
        }),
      };

      let plan = "";
      let ok = false;
      if (backend === "ts" && opts.llm) {
        // TS 直连：按段调用 LLM，结构化输出
        const result = await runImagePromptsTs(args.scriptText, opts.llm, ctx.taskId, opts.onLlmCall);
        plan = result.plan;
        ok = result.ok;
        // 落盘（与 python 路径一致的文件约定）
        if (ok) {
          await runtime.writeScript(workDir, "image_prompts.json", plan);
        }
      } else {
        // Python 子进程（默认）
        const res = await runtime.runStep("3d", workDir, { timeoutMs: getHeavyIoTimeoutMs() });
        plan = (await runtime.readScript(workDir, "image_prompts.json")) ?? "";
        ok = res.ok && plan.length > 0;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok, planBytes: plan.length }),
        }),
      };
      return {
        output: { plan },
        summary: `图片提示词生成完成 → ${plan.length} bytes`,
        narration: `图片提示词生成完成：${plan.length} 字节`,
      };
    },
  };
}

/**
 * P8.3 TS 直连：按段调用 LLM 生成 image prompt。
 * prompt 逐字移植自 ai-content-factory/pipeline_steps.py IMAGE_PROMPT_SYS。
 */
async function runImagePromptsTs(
  scriptText: string,
  llm: LlmService,
  taskId: string,
  onLlmCall?: (event: LlmCallEvent) => void,
): Promise<{ plan: string; ok: boolean }> {
  const systemPrompt = loadPrompt("image-prompts.md");
  // 与 Python 一致：双换行分段
  const paras = scriptText.split("\n\n").map((p) => p.trim()).filter((p) => p.length > 0);
  const plan: Array<{
    image_path: string;
    para_index: number;
    para_summary: string;
    theme: string;
    image_prompt: string;
    ken_burns: string;
  }> = [];

  for (let i = 0; i < paras.length; i++) {
    const para = paras[i]!;
    const imgPath = i === 0 ? "images/cover.png" : `images/para_${String(i).padStart(2, "0")}.png`;
    const summary = para.slice(0, 60).replace(/\n/g, " ");

    try {
      const { text } = await tracedGenerateText(
        llm.model("image_prompts" as CallSite),
        { system: systemPrompt, prompt: para },
        traceCtxFor(llm, "image_prompts", taskId),
        onLlmCall ?? (() => {}),
      );
      const parsed = ImagePromptEntry.parse(JSON.parse(text));
      plan.push({
        image_path: imgPath,
        para_index: i,
        para_summary: summary,
        theme: parsed.theme,
        image_prompt: parsed.image_prompt,
        ken_burns: parsed.ken_burns,
      });
    } catch {
      // 单段失败不中断整链（与 Python 一致：记空 prompt 跳过）
      plan.push({
        image_path: imgPath,
        para_index: i,
        para_summary: summary,
        theme: "",
        image_prompt: "",
        ken_burns: "zoom_in",
      });
    }
  }
  return { plan: JSON.stringify(plan, null, 2), ok: plan.length > 0 };
}
