import type { ToolRegistry } from "./registry.js";
import { createWebSearchTool } from "./builtin/web-search.js";
import { createWebFetchTool } from "./builtin/web-fetch.js";
import { createLlmNodeTool } from "./builtin/llm-node.js";
import { createDeliverTool } from "./builtin/deliver.js";
import type { LlmService } from "../services/llm-service.js";
import type { SearchProvider } from "./builtin/web-search.js";
import { SubprocessAdapter } from "./heavy-io/subprocess-adapter.js";
import { createTtsTool } from "./heavy-io/tts.js";
import { createImageGenTool } from "./heavy-io/image-gen.js";
import { createVideoBuildTool } from "./heavy-io/video-build.js";
import { createRewriteTool } from "./heavy-io/rewrite.js";
import {
  createTranslateTool,
  createSeamRepairTool,
  createTerminologyTool,
  createImagePromptsTool,
  createSubtitleTool,
} from "./builtin/text-steps.js";
import type { HeavyIoConfig } from "./heavy-io/provider.js";

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

/**
 * 注册 podcast 完整链所需的 domain 工具（P5 重 IO）。
 * 需要 SubprocessAdapter（调 ai-content-factory）+ LlmService（rewrite openai 路径）。
 */
export function registerHeavyIoTools(
  registry: ToolRegistry,
  opts: { adapter: SubprocessAdapter; llm: LlmService; config: HeavyIoConfig },
): ToolRegistry {
  const { adapter, llm, config } = opts;
  registry.register(createTranslateTool(adapter));
  registry.register(
    createRewriteTool({
      adapter,
      llm,
      backend: config.rewriteBackend ?? "ollama",
      ollamaModel: config.ollamaRewriteModel,
    }),
  );
  registry.register(createSeamRepairTool(adapter));
  registry.register(createTerminologyTool(adapter));
  registry.register(createImagePromptsTool(adapter));
  registry.register(createTtsTool(adapter));
  registry.register(createImageGenTool(adapter));
  registry.register(createSubtitleTool(adapter));
  registry.register(createVideoBuildTool(adapter));
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
