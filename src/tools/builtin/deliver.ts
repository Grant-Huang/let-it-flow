import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FlowConnector, ToolResult } from "../base.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import type { ToolEvent } from "../../core/stream-events.js";

/**
 * deliver —— 产物聚合节点（见 04 §4.4）。
 *
 * 把上游节点输出（经 inputRefs 注入到 params.items）聚合成最终产物。
 * MVP 形态：把多个 LLM 生成片段拼成完整文稿，写入产物存储，emit 一个 artifact-ish
 * 的 tool_result。
 *
 * 注：协议层 artifact 事件（@meso.ai/types ArtifactEvent）在 P5 重 IO provider
 * 落地时再实装；MVP 的 deliver 产出的是"文稿字符串"，由 P3 executor 记录到
 * ExecutionContext 供 API 查询。
 */

const inputSchema = z.object({
  /** 待聚合的文稿片段；executor 从 inputRefs 注入。支持数组或单字符串（归一为单元素数组）。 */
  items: z.union([z.array(z.string()), z.string()]).default([]).describe("待聚合的文稿片段（数组或单字符串）"),
  /** 聚合分隔符。 */
  separator: z.string().default("\n\n"),
  /** 产物类型标签（如 "podcast_script"）。 */
  artifactType: z.string().default("text"),
  title: z.string().optional(),
});

/** 把 items 归一为字符串数组。 */
function normalizeItems(items: string[] | string): string[] {
  return Array.isArray(items) ? items : [items];
}

export function createDeliverTool(): FlowConnector<{ type: string; title?: string; content: string }> {
  return {
    name: "core.deliver",
    tier: "core",
    description: "产物聚合：把上游节点输出片段拼成最终文稿，标记产物类型。",
    inputSchema: inputSchema.shape,

    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult<{ type: string; title?: string; content: string }>> {
      const args = inputSchema.parse(params);
      const items = normalizeItems(args.items);
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "core.deliver",
          args: { artifactType: args.artifactType, itemCount: items.length },
          risk: "safe",
          groupId: ctx.nodeId,
        }),
      };

      const content = items.join(args.separator);
      const artifact = { type: args.artifactType, title: args.title, content };

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(artifact) }),
      };

      return { output: artifact, summary: truncatePreview(content, 120) };
    },
  };
}

function truncatePreview(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
