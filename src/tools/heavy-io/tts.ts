import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import { getHeavyIoTimeoutMs } from "../../core/system-settings.js";
import type { TtsRuntime } from "./runtime-interfaces.js";

/**
 * TTS 工具（step4b，见 09 P5）。
 * 输入：上游 rewrite 的文稿（写入 workDir/scripts/script_v2_raw.txt）。
 * 产出：workDir/audio/voiceover_full.mp3（Qwen3-TTS 语音克隆 / Edge-TTS）。
 *
 * 默认使用 Qwen3-TTS voice_clone + Grant 参考音色（见 reference/tones/）；
 * 通过 tts.ref_audio 配置，由 LIF_TTS_REF_AUDIO 环境变量覆盖。
 *
 * 默认使用 Edge-TTS（zh-CN-YunxiNeural）；设 LIF_TTS_ENGINE=qwen 可切到
 * Qwen3-TTS voice_clone + Grant 参考音色（见 reference/tones/），需 Python 3.10+。
 *
 * 经 run_step.py 4b 调度；Qwen3-TTS 依赖 torch，用 ttsPythonBin（Qwen3-TTS venv）。
 */
const inputSchema = z.object({
  /** 上游 rewrite 文稿（executor 注入）。 */
  script: z.string().describe("待配音的播客文稿"),
  /** TTS 引擎：edge（快，默认）/ qwen（Qwen3-TTS 语音克隆，需 Python 3.10+）。 */
  engine: z.enum(["edge", "qwen"]).default(process.env.LIF_TTS_ENGINE === "qwen" ? "qwen" : "edge"),
});

export interface TtsOutput {
  audioPath: string;
  engine: string;
  durationHint?: number;
}

export function createTtsTool(runtime: TtsRuntime): FlowConnector<TtsOutput> {
  return {
    name: "domain.tts",
    tier: "domain",
    description: "播客配音（TTS）：把文稿转成 mp3。支持 Edge-TTS（快）与 Qwen3-TTS（高质量）。",
    inputSchema: inputSchema.shape,
    whenToUse: {
      triggers: ["文本转语音", "配音", "播客音频生成", "mp3 合成"],
      notFor: ["生成文稿（走 rewrite）", "字幕（走 subtitle）", "生图（走 image_gen）"],
    },
    outputSchema: {
      type: "object",
      description: "TTS 产物",
      properties: {
        audioPath: { type: "string", description: "voiceover_full.mp3 的绝对路径" },
        engine: { type: "string", enum: ["edge", "qwen"], description: "使用的 TTS 引擎" },
      },
    },
    outputExample: { audioPath: "/data/tasks/xxx/audio/voiceover_full.mp3", engine: "edge" },

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<TtsOutput>> {
      const args = inputSchema.parse(params);
      const workDir = runtime.workDirOf(ctx.taskId);
      await runtime.ensureWorkDir(workDir);

      // 把上游文稿写入 ai-content-factory 约定的脚本路径
      await runtime.writeScript(workDir, "script_v2_raw.txt", args.script);

      // 写入/合并 transcript_meta.json 的 tts 配置（tts_generator.py 读取此字段）
      // Qwen 引擎用 voice_clone + Grant 参考音色；edge 引擎走默认
      if (runtime.writeWorkFile && runtime.readWorkFile) {
        const refAudio = process.env.LIF_TTS_REF_AUDIO ?? "tones/Grant_tone.ref.wav";
        const ttsConfig =
          args.engine === "qwen"
            ? {
                backend: "qwen_tts",
                mode: "voice_clone",
                ref_audio: refAudio,
                x_vector_only_mode: true,
              }
            : { backend: "edge" };

        const existing = await runtime.readWorkFile(workDir, "transcript_meta.json");
        let meta: Record<string, unknown> = {};
        if (existing) {
          try {
            meta = JSON.parse(existing) as Record<string, unknown>;
          } catch {
            // 解析失败则用空对象重新生成
          }
        }
        meta.tts = ttsConfig;
        await runtime.writeWorkFile(workDir, "transcript_meta.json", JSON.stringify(meta, null, 2));
      }

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.tts",
          args: { engine: args.engine, scriptLen: args.script.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "tts",
        }),
      };

      const res = await runtime.runStep("4b", workDir, {
        // Qwen3-TTS 走 venv（依赖 torch）；Edge-TTS 用通用 python
        useTtsVenv: args.engine === "qwen",
        timeoutMs: getHeavyIoTimeoutMs(),
      });

      if (!res.ok) {
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({
            tool_call_id: callId,
            output: JSON.stringify({ ok: false, stderr: res.stderr.slice(-500) }),
          }),
        };
        return { output: { audioPath: "", engine: args.engine }, summary: `TTS 失败：${res.stderr.slice(-200)}` };
      }

      const audioPath = join(workDir, "audio", "voiceover_full.mp3");
      const output: TtsOutput = { audioPath, engine: args.engine };

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, audioPath }),
        }),
      };
      return { output, summary: `TTS 完成（${args.engine}）→ voiceover_full.mp3` };
    },
  };
}

/** 列出 workDir/audio 下的音频文件（调试/校验用）。 */
export async function listAudio(runtime: TtsRuntime, taskId: string): Promise<string[]> {
  try {
    return await readdir(join(runtime.workDirOf(taskId), "audio"));
  } catch {
    return [];
  }
}
