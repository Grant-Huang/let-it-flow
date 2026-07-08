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
import type { KpiResolver } from "./kpi-resolver.js";

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
  /**
   * 可选：catalog 全量工具清单（catalog 模式 server 注入）。
   *
   * 当 EmbeddingRouter 返回空候选时，让 LlmToolResolver 从 catalog 全量工具里选，
   * 而非降级到 registry 的 domain tier（拿不到 mestar 工具）。
   */
  catalogBucketProvider?: () => Array<{ name: string; title: string; desc: string; displayName?: string; triggers?: string[] }>;
  /**
   * 可选：KpiResolver 实例（catalog 模式 server 暴露 KPI 体系时注入）。
   *
   * 链路位置：作为解析链的**第一层**（在 Index 之前），负责"指标级"理解。
   * 当用户问的语义对应一个 KPI 但企业缺数据时，产出 composite 实现可解释降级。
   */
  kpiResolver?: KpiResolver;
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
  const resolvers: ToolResolver[] = [];

  // 0. KpiResolver（第一层：指标级理解，产出可解释降级）
  if (opts.kpiResolver) {
    resolvers.push(opts.kpiResolver);
  }

  // 1. IndexToolResolver（索引命中，快）
  resolvers.push(new IndexToolResolver(opts.indexPath ?? "data/relos-mock/tool-index.json"));

  // 2. 可选：插入 EmbeddingToolRouter（在 Index 之后、LLM 之前）
  if (opts.embeddingRouter && opts.embeddingRouter.isReady()) {
    resolvers.push(opts.embeddingRouter);
  }

  // 3. LlmToolResolver（LLM 推理兜底）
  if (opts.model) {
    const llmClient = makeAiLlmClient(opts.model, opts.compatMode ?? false);
    // 如果有 EmbeddingRouter，让 LlmToolResolver 只在它路由的候选里选（省 token）
    const candidateProvider = opts.embeddingRouter
      ? makeEmbeddingCandidateProvider(opts.embeddingRouter, 10)
      : undefined;
    // catalog 兜底：Embedding 候选为空时，从 catalog 全量工具里选
    const catalogFallbackProvider = opts.catalogBucketProvider
      ? () =>
          opts.catalogBucketProvider!().map((b) => ({
            name: b.name,
            description: b.displayName ? `${b.displayName}（${b.desc}）` : `${b.title}（${b.desc}）`,
            triggers: b.triggers,
          }))
      : undefined;
    resolvers.push(
      new LlmToolResolver({
        registry: opts.registry,
        llm: llmClient,
        candidateProvider,
        catalogFallbackProvider,
      }),
    );
  }

  return new CompositeToolResolver(resolvers);
}
