import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { SubprocessAdapter } from "./subprocess-adapter.js";

/**
 * 生图工具（step4a，见 09 P5）。
 * 输入：上游 image_prompts 节点产出的场景提示词（JSON，写入 workDir/scripts/image_plan.json）。
 * 产出：workDir/images/{cover,para_NN}.png（Z-Image-Turbo）。
 *
 * 模型不可用/超时时 image_generator.py 自动生成占位图，不中断流程。
 * 经 run_step.py 4a 调度。
 */
const inputSchema = z.object({
  /** 上游 image_prompts 产出的场景清单（executor 注入）。 */
  imagePlan: z
    .union([z.string(), z.array(z.unknown())])
    .describe("生图场景清单 JSON（含 image_path/para_summary 字段）"),
});

export interface ImageGenOutput {
  imageDir: string;
  count: number;
}

export function createImageGenTool(adapter: SubprocessAdapter): FlowConnector<ImageGenOutput> {
  return {
    name: "domain.image_gen",
    tier: "domain",
    description: "批量生图（Z-Image-Turbo）：按场景提示词生成封面+段落配图 PNG。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<ImageGenOutput>> {
      const args = inputSchema.parse(params);
      const workDir = adapter.workDirOf(ctx.taskId);
      await adapter.ensureWorkDir(workDir);

      // image_generator.py 读 work_dir/scripts/image_plan.json
      const planJson =
        typeof args.imagePlan === "string" ? args.imagePlan : JSON.stringify(args.imagePlan);
      await adapter.writeScript(workDir, "image_plan.json", planJson);

      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "domain.image_gen",
          args: { planBytes: planJson.length },
          risk: "safe",
          groupId: ctx.nodeId,
          groupKind: "image_gen",
        }),
      };

      const res = await adapter.runStep("4a", workDir, { timeoutMs: 900_000 });

      const imageDir = join(workDir, "images");
      let count = 0;
      try {
        const files = await readdir(imageDir);
        count = files.filter((f) => f.endsWith(".png")).length;
      } catch {
        count = 0;
      }

      if (!res.ok && count === 0) {
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({
            tool_call_id: callId,
            output: JSON.stringify({ ok: false, stderr: res.stderr.slice(-500) }),
          }),
        };
        return { output: { imageDir, count: 0 }, summary: `生图失败：${res.stderr.slice(-200)}` };
      }

      const output: ImageGenOutput = { imageDir, count };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify({ ok: true, count }),
        }),
      };
      return { output, summary: `生图完成 → ${count} 张 PNG` };
    },
  };
}
