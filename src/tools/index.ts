import type { ToolRegistry } from "./registry.js";
import { createWebSearchTool } from "./builtin/web-search.js";
import { createWebFetchTool } from "./builtin/web-fetch.js";
import { createLlmNodeTool } from "./builtin/llm-node.js";
import { createDeliverTool } from "./builtin/deliver.js";
import type { LlmService } from "../services/llm-service.js";
import type { SearchProvider } from "./builtin/web-search.js";

/**
 * 注册全部 core 内置工具到 registry（见 04 §4.11）。
 *   - web_search / web_fetch / llm_node / deliver
 * 返回 registry 以便链式/继续注册域工具。
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  opts: { llm: LlmService; searchProvider?: SearchProvider },
): ToolRegistry {
  registry.register(createWebSearchTool({ provider: opts.searchProvider }));
  registry.register(createWebFetchTool());
  registry.register(createLlmNodeTool({ llm: opts.llm }));
  registry.register(createDeliverTool());
  return registry;
}

export { ToolRegistry } from "./registry.js";
export type { FlowConnector, ToolResult, ToolTier, ExecutionContext } from "./base.js";
export { createWebSearchTool, createTavilyProvider, createNativeProvider } from "./builtin/web-search.js";
export type { SearchProvider, SearchResult } from "./builtin/web-search.js";
export { createWebFetchTool, extractHtml } from "./builtin/web-fetch.js";
export type { FetchedDoc } from "./builtin/web-fetch.js";
export { createLlmNodeTool } from "./builtin/llm-node.js";
export type { RewriteStyle } from "./builtin/llm-node.js";
export { createDeliverTool } from "./builtin/deliver.js";
