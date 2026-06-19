/**
 * MCP 模块入口（C/G 层）。
 */
export { McpClient, wrapMcpResultAsEvidence } from "./mcp-client.js";
export type {
  McpServerConfig,
  McpToolDescriptor,
  McpResourceDescriptor,
  McpToolCallResult,
} from "./mcp-client.js";
export { McpRouter } from "./mcp-router.js";
export { createMcpActionTool, registerMcpServerTools } from "./mcp-action-tool.js";
export type { McpActionToolOptions } from "./mcp-action-tool.js";
export { McpKnowledgeProvider } from "./mcp-knowledge-provider.js";
export type { McpKnowledgeProviderOptions } from "./mcp-knowledge-provider.js";
