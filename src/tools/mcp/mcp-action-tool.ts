/**
 * MCP 动作工具工厂（T 层 —— 把 MCP server 工具桥接成 FlowConnector）。
 *
 * MCP server 提供的工具通常是真实企业系统操作（改排产、下达工单、停线），
 * 风险高。本工厂为每个 MCP 工具生成一个 FlowConnector：
 *   - 风险评级：根据工具名/输入推断（write/destructive 默认要求确认）
 *   - 执行：转调 McpClient.callTool，结果包成 EvidenceEnvelope
 *
 * 让 MCP 工具像平台原生工具一样进 ToolRegistry，被 ReAct 主循环复用。
 */
import type { FlowConnector, ToolResult } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { wrapMcpResultAsEvidence } from "./mcp-client.js";
import type { McpClient, McpToolDescriptor } from "./mcp-client.js";

/** 工厂参数。 */
export interface McpActionToolOptions {
  /** MCP server id（如 "mes"）。 */
  serverId: string;
  /** MCP 工具描述符（来自 listTools）。 */
  descriptor: McpToolDescriptor;
  /** 已连接的 MCP 客户端。 */
  client: McpClient;
  /** 强制风险评级（缺省按名字推断）。 */
  risk?: "safe" | "write" | "destructive";
  /** 数据时效性（缺省 realtime）。 */
  freshness?: "realtime" | "shift" | "daily" | "weekly" | "historical";
}

/**
 * 把一个 MCP 工具适配成 FlowConnector。
 *
 * 命名规则：mcp.<serverId>.<toolName>（如 mcp.mes.update_schedule）。
 *
 * emit 责任：selfEmitEvents 缺省（false），工具 execute 不 yield tool_call/tool_result，
 * 由编排层（tool-adapter / node-runner）统一 emit。MCP 工具的事件语义是机械的
 * （无定制 args 预览、无流式增量），外层可完整重建，故走外层统一 emit 更干净。
 */
export function createMcpActionTool(opts: McpActionToolOptions): FlowConnector {
  const { serverId, descriptor, client } = opts;
  const name = `mcp.${serverId}.${descriptor.name}`;
  const risk =
    opts.risk ?? inferRisk(descriptor.name, descriptor.description ?? "");
  const freshness = opts.freshness ?? "realtime";

  const triggers = inferTriggers(descriptor);
  const notFor = ["仅查询只读场景（用 domain.* 查询工具）"];

  const connector: FlowConnector = {
    name,
    tier: "custom",
    description:
      descriptor.description ?? `MCP 工具 ${name}（来自 server ${serverId}）`,
    inputSchema: descriptor.inputSchema ?? {
      type: "object",
      properties: {},
    },
    whenToUse: { triggers, notFor },
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
      freshness,
      capturedAt: new Date().toISOString(),
      confidence: "measured",
      source: { system: serverId, provenance: name },
    },
    risk,

    async *execute(
      params: Record<string, unknown>,
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const result = await client.callTool(descriptor.name, params);
      const envelope = wrapMcpResultAsEvidence(result, {
        freshness,
        system: serverId,
        provenance: `${name}(${JSON.stringify(params).slice(0, 80)})`,
      });

      return {
        output: envelope,
        summary: `MCP ${name} ${envelope.data && (envelope.data as { isError?: boolean }).isError ? "出错" : "完成"}`,
      };
    },
  };

  return connector;
}

/**
 * 批量注册 MCP server 的全部工具到 ToolRegistry。
 * server 未连接或 listTools 失败时静默跳过（降级，不阻塞启动）。
 */
export async function registerMcpServerTools(
  registry: import("../registry.js").ToolRegistry,
  router: import("./mcp-router.js").McpRouter,
  serverId: string,
  opts: { risk?: "safe" | "write" | "destructive"; freshness?: "realtime" | "shift" | "daily" | "weekly" | "historical" } = {},
): Promise<number> {
  const client = router.getClient(serverId);
  if (!client) return 0;
  let tools: Awaited<ReturnType<typeof client.listTools>>;
  try {
    tools = await client.listTools();
  } catch {
    return 0;
  }
  for (const descriptor of tools) {
    const connector = createMcpActionTool({
      serverId,
      descriptor,
      client,
      risk: opts.risk,
      freshness: opts.freshness,
    });
    registry.register(connector);
  }
  return tools.length;
}

/** 根据工具名/描述推断风险评级。 */
function inferRisk(name: string, description: string): "safe" | "write" | "destructive" {
  const lc = `${name} ${description}`.toLowerCase();
  // destructive 关键词：停线、删除、下线、终止
  if (/stop_line|pause_line|delete|remove|terminate|停线|下线|删除|终止/.test(lc)) {
    return "destructive";
  }
  // write 关键词：更新、创建、修改、下达、提交
  if (/update|create|modify|submit|issue|change|set|更新|创建|修改|下达|提交|调整/.test(lc)) {
    return "write";
  }
  return "safe";
}

/** 从描述推断 triggers。 */
function inferTriggers(descriptor: McpToolDescriptor): string[] {
  const triggers: string[] = [];
  if (descriptor.description) {
    // 取描述前几个关键词作为触发器
    triggers.push(descriptor.description.slice(0, 60));
  }
  triggers.push(`MCP ${descriptor.name}`);
  return triggers;
}
