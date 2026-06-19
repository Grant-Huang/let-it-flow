/**
 * 知识库模块入口（C 层）。
 */
export type {
  IKnowledgeProvider,
  KnowledgeSnippet,
  KnowledgeQuery,
} from "./provider.js";
export { wrapSnippetAsEvidence } from "./provider.js";
export { ObsidianProvider } from "./obsidian-provider.js";
export type { ObsidianProviderOptions } from "./obsidian-provider.js";
