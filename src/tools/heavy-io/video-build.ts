import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { SubprocessAdapter } from "./subprocess-adapter.js";

/**
 * 视频合成工具（step6，见 09 P5）。
 * 依赖：上游 tts 产出的 audio/voiceover_full.mp3 + image_gen 产出的 images/*.png
 *       + step5 字幕对齐产出的 scenes 数据。
 * 产出：workDir/video/final.mp4（FFmpeg 合成）。
 *
 * 经 run_step.py 6 调度（内部调 build_video.py）。
 */
const inputSchema = z.object({
  /** 上游 tts 的音频路径（校验用，实际由 run_step 从 workDir 读）。 */
  audioPath: z.string().optional(),
  /** 上游 image_gen 的图片数（校验用）。 */
  imageCount: z.number().int().nonnegative().optional(),
});

export interface VideoBuildOutput {
  videoPath: string;
}

export function createVideoBuildTool(adapter: SubprocessAdapter): FlowConnector<VideoBuildOutput> {
  return {
    name: "domain.video_build",
    tier: "domain",
    description: "视频合成（FFmpeg）：配音+配图+字幕 → final.mp4。需上游 tts/image_gen/字幕就绪。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<VideoBuildOutput>> {
      const args = inputSchema.parse(params);
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.video_build",
          args: { hasAudio: !!args.audioPath, imageCount: args.imageCount ?? 0 },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "video_build",
        }),
      };

      // step6 依赖 step5（字幕对齐）已产出 scenes 数据；step5 在模板里先于 step6 执行
      const res = await adapter.runStep("6", workDir, { timeoutMs: 900_000 });
      const videoPath = join(workDir, "video", "final.mp4");

      if (!res.ok) {
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({
            tool_call_id: callId,
            output: JSON.stringify({ ok: false, stderr: res.stderr.slice(-500) }),
          }),
        };
        return { output: { videoPath: "" }, summary: `视频合成失败：${res.stderr.slice(-200)}` };
      }

      const output: VideoBuildOutput = { videoPath };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, videoPath }),
        }),
      };
      return { output, summary: "视频合成完成 → final.mp4" };
    },
  };
}
