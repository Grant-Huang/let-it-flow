import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { SubprocessAdapter } from "../heavy-io/subprocess-adapter.js";

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

/** 通用：把上游文本写入约定的输入文件，跑步骤，读输出文件。 */
function makeStepTool(opts: {
  name: string;
  description: string;
  groupKind: string;
  step: string;
  /** 上游文本注入到的输入文件名（相对 scripts/）。 */
  inputScript: string;
  /** 输出文件名（相对 scripts/）。 */
  outputScript: string;
  /** 上游文本参数名（executor 注入键）。 */
  inputParam: string;
}): (adapter: SubprocessAdapter) => FlowConnector<{ text: string }> {
  const { name, description, groupKind, step, inputScript, outputScript, inputParam } = opts;
  const schema = z.object({
    [inputParam]: z.string().describe("上游文本"),
  });
  return (adapter: SubprocessAdapter) => ({
    name,
    tier: "domain",
    description,
    inputSchema: schema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ text: string }>> {
      const args = schema.parse(params) as Record<string, string>;
      const inputText = args[inputParam] ?? "";
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);
      await adapter.writeScript(workDir, inputScript, inputText);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name,
          args: { inputLen: inputText.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind,
        }),
      };

      const res = await adapter.runStep(step, workDir, { timeoutMs: 900_000 });
      const out = await adapter.readScript(workDir, outputScript);
      const text = out ?? "";

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: res.ok && text.length > 0, len: text.length }),
        }),
      };
      return { output: { text }, summary: `${name} 完成 → ${text.length} 字` };
    },
  });
}

/** step2 翻译：original_transcript.txt → script_v1_chunk_NN.txt（拼接为单文本）。 */
export const createTranslateTool = makeStepTool({
  name: "domain.translate",
  description: "分段初译（step2，Qwen2.5-14B）：把原文稿译成目标语言。",
  groupKind: "translate",
  step: "2",
  inputScript: "original_transcript.txt",
  outputScript: "translated.txt",
  inputParam: "sourceText",
});

/** step3b 接缝修复：script_v2_raw.txt → script_v2_seamed.txt。 */
export const createSeamRepairTool = makeStepTool({
  name: "domain.seam_repair",
  description: "接缝修复（step3b，35B）：修复相邻段边界的断层/重复/悬空过渡。",
  groupKind: "seam_repair",
  step: "3b",
  inputScript: "script_v2_raw.txt",
  outputScript: "script_v2_seamed.txt",
  inputParam: "rewriteText",
});

/** step3c 术语统一：script_v2_seamed.txt → script_v2.txt（权威文本）。 */
export const createTerminologyTool = makeStepTool({
  name: "domain.terminology",
  description: "术语统一（step3c，14B）：统一同概念的不同表达，产出权威文本。",
  groupKind: "terminology",
  step: "3c",
  inputScript: "script_v2_seamed.txt",
  outputScript: "script_v2.txt",
  inputParam: "seamedText",
});

/** step5 字幕对齐（step5，内部含 wav/whisper/align/srt 子步）。 */
export function createSubtitleTool(adapter: SubprocessAdapter): FlowConnector<{ srtPath: string }> {
  const schema = z.object({
    audioPath: z.string().optional().describe("上游 tts 音频路径（校验用）"),
  });
  return {
    name: "domain.subtitle",
    tier: "domain",
    description: "字幕对齐（step5）：配音 → wav → whisper 转录 → 段落对齐 → srt。",
    inputSchema: schema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ srtPath: string }>> {
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);
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
      const res = await adapter.runStep("5", workDir, { timeoutMs: 900_000 });
      // step5d 产出 srt；尝试常见路径
      const srt = (await adapter.readScript(workDir, "final.srt")) ?? "";
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: res.ok, hasSrt: srt.length > 0 }),
        }),
      };
      return { output: { srtPath: srt ? `${workDir}/scripts/final.srt` : "" }, summary: "字幕对齐完成" };
    },
  };
}

/**
 * step3d 图片提示词：script_v2.txt → scripts/image_prompts.json。
 * 这个工具比较特殊：输出是 JSON（供 image_gen 节点消费），而非纯文本。
 */
export function createImagePromptsTool(adapter: SubprocessAdapter): FlowConnector<{ plan: string }> {
  const schema = z.object({
    scriptText: z.string().describe("权威文本（script_v2.txt 内容）"),
  });
  return {
    name: "domain.image_prompts",
    tier: "domain",
    description: "图片提示词生成（step3d，14B）：按段落生成英文生图提示词 + ken_burns 效果。",
    inputSchema: schema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ plan: string }>> {
      const args = schema.parse(params);
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);
      await adapter.writeScript(workDir, "script_v2.txt", args.scriptText);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.image_prompts",
          args: { scriptLen: args.scriptText.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "image_prompts",
        }),
      };

      const res = await adapter.runStep("3d", workDir, { timeoutMs: 900_000 });
      const plan = (await adapter.readScript(workDir, "image_prompts.json")) ?? "";

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: res.ok && plan.length > 0, planBytes: plan.length }),
        }),
      };
      return { output: { plan }, summary: `图片提示词生成完成 → ${plan.length} bytes` };
    },
  };
}
