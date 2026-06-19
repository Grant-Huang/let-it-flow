/**
 * MCP 客户端封装（C 层框架 —— 平台提供客户端，应用配置 server）。
 *
 * 封装 @modelcontextprotocol/sdk 的 stdio/http 传输，统一暴露：
 *   - listTools(): 拿 server 提供的工具清单
 *   - callTool(name, args): 调 server 工具
 *   - listResources() / readResource(): 拿 server 资源（KB 语义）
 *
 * 设计为可 mock（测试用），应用通过 MCPRouter 管理多个 server 连接。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EvidenceEnvelope } from "../../core/evidence-envelope.js";

/** MCP server 配置形态。 */
export interface McpServerConfig {
  /** server 唯一 id（如 "mes" / "wiki"）。 */
  id: string;
  /** 传输类型。 */
  transport: "stdio" | "http";
  /** stdio: 启动命令 + 参数；http: url。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 启动后等待就绪的超时 ms（缺省 10000）。 */
  timeoutMs?: number;
}

/** MCP 工具清单项。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 资源清单项。 */
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** MCP 工具调用结果（统一形态）。 */
export interface McpToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  isError?: boolean;
}

/**
 * 单个 MCP server 客户端。
 * 延迟连接：首次 listTools/callTool/readResource 时才 transport.start()。
 */
export class McpClient {
  readonly id: string;
  private readonly config: McpServerConfig;
  private client?: Client;
  private connected = false;
  private connecting?: Promise<void>;

  constructor(config: McpServerConfig) {
    this.id = config.id;
    this.config = config;
  }

  /** 是否已连接。 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 建立连接（幂等，并发安全）。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    await this.connecting;
    this.connecting = undefined;
  }

  /** 断开连接。 */
  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.client = undefined;
    }
  }

  /** 列出 server 提供的工具。 */
  async listTools(): Promise<McpToolDescriptor[]> {
    await this.connect();
    const r = await this.client!.listTools();
    return r.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /** 调用 server 工具。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.connect();
    const r = await this.client!.callTool({ name, arguments: args });
    return r as unknown as McpToolCallResult;
  }

  /** 列出 server 资源（KB 语义）。 */
  async listResources(): Promise<McpResourceDescriptor[]> {
    await this.connect();
    const r = await this.client!.listResources();
    return r.resources.map((res) => ({
      uri: res.uri,
      name: res.name,
      description: res.description,
      mimeType: res.mimeType,
    }));
  }

  /** 读取单个资源（按 uri）。 */
  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; text?: string; mimeType?: string }> }> {
    await this.connect();
    const r = await this.client!.readResource({ uri });
    return r as unknown as { contents: Array<{ uri: string; text?: string; mimeType?: string }> };
  }

  // ── 内部 ──

  private async doConnect(): Promise<void> {
    const transport =
      this.config.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(this.config.url ?? ""))
        : new StdioClientTransport({
            command: this.config.command ?? "",
            args: this.config.args ?? [],
            env: this.config.env as Record<string, string> | undefined,
          });

    this.client = new Client(
      {
        name: "let-it-flow-harness",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await this.client.connect(transport);
    this.connected = true;
  }
}

/**
 * MCP 工具调用结果 → EvidenceEnvelope（MCP 类证据统一信封）。
 * MCP 默认 confidence=measured（MES/ERP 实测），freshness 由调用者指定。
 */
export function wrapMcpResultAsEvidence(
  result: McpToolCallResult,
  opts: { freshness?: EvidenceEnvelope["freshness"]; system: string; provenance: string },
): EvidenceEnvelope {
  const textParts = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);
  return {
    data: {
      content: result.content,
      text: textParts.join("\n"),
      isError: result.isError ?? false,
    },
    freshness: opts.freshness ?? "realtime",
    capturedAt: new Date().toISOString(),
    confidence: "measured",
    source: { system: opts.system, provenance: opts.provenance },
    ...(result.isError ? { caveat: "工具返回错误状态" } : {}),
  };
}
