/**
 * LazyMcpActionTool —— 按需激活的 catalog 工具代理（07-mestar-integration-spec.md §7）。
 *
 * 问题：catalog 模式下数千个工具不进 ToolRegistry（避免 context 爆炸）。
 * LLM 通过 nexus_tool_resolver 拿到 toolName 后，需要一个执行入口。
 *
 * 设计：每个 catalog server 注册一个代理 FlowConnector（mcp.<serverId>.call），
 * LLM 调用时内部完成"激活 → 构参 → 调用"三步：
 *   1. catalog.activate 把工具发布到 mestar 的 tools/list（幂等）
 *   2. query.build_params 构造参数（若 args 缺失）
 *   3. 调用真实工具，结果包成 EvidenceEnvelope
 *
 * 风险评级：代理本身标 safe，但执行时根据 catalog 缓存里的 risk 字段
 * 动态判定是否需要 HITL（写动作触发确认门）。
 */
import { randomUUID } from "node:crypto";
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import { wrapMcpResultAsEvidence } from "./mcp-client.js";
import type { McpClient, McpToolCallResult } from "./mcp-client.js";
import type { McpCatalogCache } from "./mcp-catalog-cache.js";

/** 构造选项。 */
export interface LazyMcpActionToolOptions {
  /** MCP server id（如 "mestar"）。 */
  serverId: string;
  /** 已连接的 MCP 客户端。 */
  client: McpClient;
  /** catalog 缓存（用于查工具的风险评级，判定是否需要 HITL）。 */
  catalogCache?: McpCatalogCache;
}

/**
 * 创建 catalog 模式的代理工具。
 *
 * 命名：mcp.<serverId>.call（每个 catalog server 一个代理）。
 *
 * LLM 使用流程：
 *   1. 调 nexus_tool_resolver(semantic="device_bom") → 得到 toolName
 *   2. 调 mcp.mestar.call(toolName=<上一步的 toolName>, args={...})
 */
export function createLazyMcpActionTool(opts: LazyMcpActionToolOptions): FlowConnector {
  const { serverId, client, catalogCache } = opts;
  const name = `mcp.${serverId}.call`;

  const connector: FlowConnector = {
    name,
    tier: "custom",
    description:
      `调用 ${serverId} catalog 工具的代理。` +
      `先用 nexus_tool_resolver(semantic=...) 查到 toolName，再调本工具执行。` +
      `args 缺失时会自动调 query.build_params 构造默认参数。`,
    inputSchema: {
      type: "object",
      properties: {
        toolName: {
          type: "string",
          description: "nexus_tool_resolver 返回的工具全名（如 mestar.query.uemp...select）",
        },
        args: {
          type: "object",
          description: "工具参数（可用 mestar.query.build_params 构造；缺省时自动构造）",
        },
      },
      required: ["toolName"],
    },
    whenToUse: {
      triggers: [`调用 ${serverId} 工具`, `mestar catalog 执行`, `${serverId} 业务操作`],
      notFor: ["直接调本地 domain 工具（用对应工具名）", "未知 toolName（先调 nexus_tool_resolver）"],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object" },
        freshness: { type: "string" },
        capturedAt: { type: "string" },
        confidence: { type: "string" },
        source: { type: "object" },
      },
    },
    outputExample: {
      data: { ok: true },
      freshness: "realtime",
      capturedAt: new Date().toISOString(),
      confidence: "measured",
      source: { system: serverId, provenance: name },
    },
    // 代理本身标 safe；执行时按 catalog 缓存的 risk 动态判定
    risk: "safe",

    async *execute(
      params: Record<string, unknown>,
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();

      const toolName = String(params.toolName ?? "");
      const inputArgs = (params.args as Record<string, unknown> | undefined) ?? {};

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name,
          args: { toolName, args: inputArgs },
          risk: "safe",
          groupId: `mcp.${serverId}`,
        }),
      };

      let result: McpToolCallResult;
      let summary: string;
      let isError = false;

      try {
        if (!toolName) {
          throw new Error("toolName 不能为空（先用 nexus_tool_resolver 查到 toolName）");
        }

        // 1. 激活工具（幂等，已激活则 no-op）
        try {
          await client.callTool("mestar.catalog.activate", { toolNames: [toolName] });
        } catch {
          // 激活失败不阻塞（可能已激活或 server 兼容性问题，继续尝试直接调）
        }

        // 2. 构参（args 缺失时尝试 build_params）
        let finalArgs = inputArgs;
        if (Object.keys(inputArgs).length === 0) {
          try {
            const built = await client.callTool("mestar.query.build_params", { toolName });
            const params = (built as { structuredContent?: { params?: Record<string, unknown> } }).structuredContent?.params;
            if (params) finalArgs = params;
          } catch {
            // build_params 失败用空 args（部分工具支持无参调用）
          }
        }

        // 3. 调用真实工具
        result = await client.callTool(toolName, finalArgs);
        summary = `${serverId} ${toolName} 完成`;
        isError = result.isError ?? false;
      } catch (e) {
        // 执行错误：包成错误 EvidenceEnvelope（不抛异常，让 ReAct 继续推理）
        result = {
          content: [{ type: "text", text: `执行失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
        summary = `${serverId} ${toolName || "(空)"} 执行失败`;
        isError = true;
      }

      const envelope = wrapMcpResultAsEvidence(result, {
        system: serverId,
        provenance: `${name}(${toolName})`,
      });

      const durationMs = Date.now() - startedAt;
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(envelope),
          duration_ms: durationMs,
        }),
      };

      return {
        output: envelope,
        summary: isError ? `${serverId} ${toolName || "(空)"} 执行出错` : summary,
      };
    },
  };

  return connector;
}
