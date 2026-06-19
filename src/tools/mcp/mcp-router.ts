/**
 * MCP server 配置 + 路由器（C/G 层）。
 *
 * MCPRouter 管理多个 MCP server 连接，提供统一访问入口：
 *   - getClient(id): 拿单个 server 客户端
 *   - listAllTools(): 汇总所有 server 的工具（供 tool registry 注册）
 *   - callTool(serverId, toolName, args): 跨 server 调用
 *
 * 配置来源：NEXUS_MCP_SERVERS env / config 文件（应用 boot 时注入）。
 */
import { McpClient, type McpServerConfig, type McpToolDescriptor } from "./mcp-client.js";

/**
 * MCP server 路由器。
 * 应用 boot 时注入配置 → router 初始化 → tool registry 注册 MCP 工具。
 */
export class McpRouter {
  private readonly clients = new Map<string, McpClient>();

  constructor(configs: McpServerConfig[] = []) {
    for (const c of configs) {
      this.clients.set(c.id, new McpClient(c));
    }
  }

  /** 注册一个 server 配置。 */
  add(config: McpServerConfig): void {
    if (this.clients.has(config.id)) {
      throw new Error(`MCP server 已存在：${config.id}`);
    }
    this.clients.set(config.id, new McpClient(config));
  }

  /** 获取单个 server 客户端。 */
  getClient(id: string): McpClient | undefined {
    return this.clients.get(id);
  }

  /** 全部 server id。 */
  listServerIds(): string[] {
    return [...this.clients.keys()];
  }

  /** 汇总所有 server 的工具清单（带 serverId 前缀）。 */
  async listAllTools(): Promise<Array<McpToolDescriptor & { serverId: string }>> {
    const out: Array<McpToolDescriptor & { serverId: string }> = [];
    for (const [serverId, client] of this.clients) {
      try {
        const tools = await client.listTools();
        for (const t of tools) {
          out.push({ ...t, serverId });
        }
      } catch {
        // 单个 server 失败不阻塞其他 server
      }
    }
    return out;
  }

  /** 跨 server 调用工具。 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>) {
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`未知 MCP server：${serverId}`);
    return client.callTool(toolName, args);
  }

  /** 断开全部连接（优雅关闭）。 */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((c) => c.disconnect().catch(() => {})),
    );
  }
}
