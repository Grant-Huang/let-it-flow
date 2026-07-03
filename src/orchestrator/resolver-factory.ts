/**
 * ToolResolver 工厂（L3 工具解析层 —— 装配）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md §3.2
 * 与 07-mestar-integration-spec.md §2（五层解析管道）。
 *
 * 组合解析链（按优先级）：
 *   ① IndexToolResolver（快，读 data/relos-mock/tool-index.json）
 *   ② EmbeddingToolRouter（中，向量检索 top-K，07-mestar §6）
 *   ③ LlmToolResolver（慢，LLM 推理兜底，限定域内候选）
 *
 * EmbeddingRouter 是可选注入（catalog 模式的 server 才有），
 * 无注入时降级为 ① + ③（现有行为，向后兼容）。
 * 注：syncToolIndex 写出的 tool-index.json 由 IndexToolResolver 直接消费。
 */
import { generateText, type LanguageModel } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResolver } from "./tool-resolver.js";
import { IndexToolResolver } from "./index-resolver.js";
import { LlmToolResolver, makeEmbeddingCandidateProvider, type LlmClient } from "./llm-resolver.js";
import { CompositeToolResolver } from "./composite-resolver.js";
import type { EmbeddingToolRouter } from "./embedding-router.js";

/** 工厂选项。 */
export interface ToolResolverOptions {
  /** 工具注册表（提供工具清单给 LLM 推理）。 */
  registry: ToolRegistry;
  /** 索引文件路径（缺省 data/relos-mock/tool-index.json）。 */
  indexPath?: string;
  /** LLM 模型（注入则启用 LLM 兜底档；缺省只用索引档）。 */
  model?: LanguageModel;
  /** 兼容模式（DeepSeek 等折叠 system 进 user）。 */
  compatMode?: boolean;
  /** 可选：EmbeddingToolRouter 实例（catalog 模式 server 注入）。 */
  embeddingRouter?: EmbeddingToolRouter;
}

/**
 * 把 ai SDK 的 generateText 包装成 LlmClient（LlmToolResolver 需要的契约）。
 */
function makeAiLlmClient(model: LanguageModel, compatMode: boolean): LlmClient {
  return {
    async complete(prompt: string): Promise<string> {
      const callArgs = compatMode
        ? { messages: [{ role: "user" as const, content: prompt }] }
        : { system: "你是工具选择助手。只返回 JSON。", messages: [{ role: "user" as const, content: prompt }] };
      const { text } = await generateText({
        model,
        ...callArgs,
        temperature: 0,
        maxOutputTokens: 200,
      });
      return text;
    },
  };
}

/**
 * 创建 ToolResolver 实例。
 *
 * @returns CompositeToolResolver（调用方不感知内部档位）
 */
export function createToolResolver(opts: ToolResolverOptions): ToolResolver {
  const resolvers: ToolResolver[] = [new IndexToolResolver(opts.indexPath ?? "data/relos-mock/tool-index.json")];

  // 可选：插入 EmbeddingToolRouter（在 Index 之后、LLM 之前）
  if (opts.embeddingRouter && opts.embeddingRouter.isReady()) {
    resolvers.push(opts.embeddingRouter);
  }

  if (opts.model) {
    const llmClient = makeAiLlmClient(opts.model, opts.compatMode ?? false);
    // 如果有 EmbeddingRouter，让 LlmToolResolver 只在它路由的候选里选（省 token）
    const candidateProvider = opts.embeddingRouter
      ? makeEmbeddingCandidateProvider(opts.embeddingRouter, 10)
      : undefined;
    resolvers.push(new LlmToolResolver({ registry: opts.registry, llm: llmClient, candidateProvider }));
  }

  return new CompositeToolResolver(resolvers);
}
