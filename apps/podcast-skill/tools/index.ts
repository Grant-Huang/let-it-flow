/**
 * Podcast-Skill 应用工具集（T 内容）。
 *
 * 现阶段没有 domain.* 业务工具（核心检索复用 core.web_search/web_fetch），
 * 只贡献两个收尾工具：
 *   - podcast_finalize：收尾 sentinel（harness stopWhen 检测）
 *   - podcast_ask_choice：HITL 反问入口（覆盖 NeedsUserChoice 场景）
 */
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../src/core/stream-events.js";
import { randomUUID } from "node:crypto";

export function buildPodcastTools(): FlowConnector[] {
  return [createFinalizeTool(), createAskChoiceTool()];
}

function createFinalizeTool(): FlowConnector {
  return {
    name: "podcast_finalize",
    tier: "core",
    description:
      "播客任务收尾工具。当口播稿 + 公众号长文都已生成且证据充分时调用，结束 ReAct 循环。证据不全时禁止调用。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "本期内容摘要" },
        rationaleMeta: {
          type: "object",
          description: "理由元信息：focusedThreadId / narrative / citationCoverage 等",
        },
      },
      required: ["summary"],
    },
    whenToUse: {
      triggers: ["播客任务完成", "口播稿和长文都已就绪"],
      notFor: ["仅完成口播稿（再写公众号）", "尚未聚焦主线索"],
    },
    outputSchema: { type: "object", properties: { finalized: { type: "boolean" } } },
    outputExample: { finalized: true },
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "podcast_finalize",
          args: params,
          risk: "safe",
          groupId: "podcast",
        }),
      };
      const output = {
        finalized: true,
        summary: params.summary,
        rationaleMeta: params.rationaleMeta ?? {},
      };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(output),
          duration_ms: 0,
        }),
      };
      return { output, summary: "podcast 收尾" };
    },
  };
}

/**
 * podcast_ask_choice：HITL 反问工具。
 *
 * 用法：当 skill.thread_focuser 返回 needsUserChoice=true + options 时，
 * 主 ReAct 调本工具触发 requireConfirmation；HITL 桥把用户选择回填到下一轮参数。
 */
function createAskChoiceTool(): FlowConnector {
  return {
    name: "podcast_ask_choice",
    tier: "core",
    description:
      "向用户反问，从给定选项中选择一项。用于 thread_focuser 抛 needsUserChoice 时确定聚焦线索。",
    risk: "write", // 触发 HITL 确认门
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "向用户提的问题" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
            required: ["id", "label"],
          },
          description: "可选项列表",
        },
      },
      required: ["prompt", "options"],
    },
    whenToUse: {
      triggers: ["多条线索需用户选择", "时间范围需澄清", "narrative 风格需用户决定"],
      notFor: ["有充分依据可直接选时（不要不必要地反问）"],
    },
    outputSchema: { type: "object", properties: { selectedId: { type: "string" } } },
    outputExample: { selectedId: "t1" },
    async *execute(params, ctx): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "podcast_ask_choice",
          args: params,
          risk: "write",
          groupId: ctx.nodeId,
        }),
      };
      // 实际 HITL 由 tool-adapter 的 requireConfirmation 处理（基于 risk）；
      // 这里直接把 LLM 给的"假设回答"回写出去（若 HITL 桥已介入，此处不会触达）。
      const output = {
        selectedId: params.selectedId ?? (Array.isArray(params.options) ? (params.options as Array<{ id: string }>)[0]?.id : undefined),
        prompt: params.prompt,
      };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(output),
          duration_ms: 0,
        }),
      };
      return { output, summary: "用户已选择" };
    },
  };
}
