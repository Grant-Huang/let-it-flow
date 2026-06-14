import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { SubprocessAdapter } from "./subprocess-adapter.js";

/**
 * TTS 工具（step4b，见 09 P5）。
 * 输入：上游 rewrite 的文稿（写入 workDir/scripts/script_v2_raw.txt）。
 * 产出：workDir/audio/voiceover_full.mp3（Edge-TTS 或 Qwen3-TTS）。
 *
 * 经 run_step.py 4b 调度；TTS 依赖 torch 时用 ttsPythonBin（Qwen3-TTS venv）。
 */
const inputSchema = z.object({
  /** 上游 rewrite 文稿（executor 注入）。 */
  script: z.string().describe("待配音的播客文稿"),
  /** TTS 引擎：edge（快）/ qwen（Qwen3-TTS，质量好）。 */
  engine: z.enum(["edge", "qwen"]).default("edge"),
});

export interface TtsOutput {
  audioPath: string;
  engine: string;
  durationHint?: number;
}

export function createTtsTool(adapter: SubprocessAdapter): FlowConnector<TtsOutput> {
  return {
    name: "domain.tts",
    tier: "domain",
    description: "播客配音（TTS）：把文稿转成 mp3。支持 Edge-TTS（快）与 Qwen3-TTS（高质量）。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<TtsOutput>> {
      const args = inputSchema.parse(params);
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);

      // 把上游文稿写入 ai-content-factory 约定的脚本路径
      await adapter.writeScript(workDir, "script_v2_raw.txt", args.script);

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

      const res = await adapter.runStep("4b", workDir, {
        // Qwen3-TTS 走 venv（依赖 torch）；Edge-TTS 用通用 python
        useTtsVenv: args.engine === "qwen",
        timeoutMs: 900_000,
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
export async function listAudio(adapter: SubprocessAdapter, taskId: string): Promise<string[]> {
  try {
    return await readdir(join(adapter.workDirOf(taskId), "audio"));
  } catch {
    return [];
  }
}
