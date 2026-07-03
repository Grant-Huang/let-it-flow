/**
 * LlmToolResolver（L3 工具解析层 —— LLM 推理档）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md §3.2 档位 ②。
 *
 * 数据源：ToolRegistry.forPlanner()（现有方法）+ LLM 推理。
 * 当 IndexToolResolver 未命中时启用，source="llm"，confidence=0.7。
 *
 * LLM 解析慢（1-3 秒），调用方应缓存结果。
 *
 * Phase M2 增强（07-mestar-integration-spec.md §6）：支持限定候选集合。
 * 当 EmbeddingToolRouter 已路由出 top-K 候选时，本 resolver 只把候选喂给 LLM，
 * 而非全量 domain 工具，把 prompt token 从 ~140K 降到 ~4K。
 */
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResolver, ResolvedTool } from "./tool-resolver.js";
import type { BizContext, SemanticNeed } from "./types.js";
import type { CandidateTool } from "./embedding-router.js";

/** LLM 客户端接口（最小契约，便于注入不同实现）。 */
export interface LlmClient {
  /** 非流式补全，返回文本。 */
  complete(prompt: string): Promise<string>;
}

/** 候选工具的精简清单项（喂给 LLM 用）。 */
interface CandidateManifest {
  name: string;
  description: string;
  triggers?: string[];
}

/** 构造选项。 */
export interface LlmToolResolverOptions {
  registry: ToolRegistry;
  llm: LlmClient;
  /** 限定候选集合（注入时只在小集合里选；缺省走 registry 全量）。 */
  candidateProvider?: (need: SemanticNeed) => Promise<CandidateManifest[] | null>;
}

/**
 * LLM 推理解析器：索引未命中时，让 LLM 从工具清单里选最匹配的工具。
 *
 * 依赖外部注入 LlmClient（生产用真实 LLM，测试用 stub）。
 */
export class LlmToolResolver implements ToolResolver {
  private readonly registry: ToolRegistry;
  private readonly llm: LlmClient;
  private readonly candidateProvider?: (need: SemanticNeed) => Promise<CandidateManifest[] | null>;

  constructor(registry: ToolRegistry, llm: LlmClient);
  constructor(opts: LlmToolResolverOptions);
  constructor(registryOrOpts: ToolRegistry | LlmToolResolverOptions, llm?: LlmClient) {
    if (llm) {
      // 旧签名（registry, llm）
      this.registry = registryOrOpts as ToolRegistry;
      this.llm = llm;
    } else {
      // 新签名（options 对象）
      const opts = registryOrOpts as LlmToolResolverOptions;
      this.registry = opts.registry;
      this.llm = opts.llm;
      this.candidateProvider = opts.candidateProvider;
    }
  }

  async resolve(need: SemanticNeed, ctx: BizContext): Promise<ResolvedTool | null> {
    // 取候选工具清单：优先用 candidateProvider（限定集合），否则全量 domain
    let toolList: CandidateManifest[];
    let scoped = false;

    if (this.candidateProvider) {
      const candidates = await this.candidateProvider(need);
      if (candidates && candidates.length > 0) {
        toolList = candidates;
        scoped = true;
      } else {
        toolList = this.getFullDomainManifests();
      }
    } else {
      toolList = this.getFullDomainManifests();
    }

    // 简化 prompt（避免传整个 schema 耗 token）
    const scopeLabel = scoped
      ? `（限定 ${toolList.length} 个候选）`
      : `（全量 ${toolList.length} 个 domain 工具）`;

    const prompt = `业务语义需求：${need.semantic}${need.description ? `（${need.description}）` : ""}
当前产线：${ctx.line ?? "L01"}

可用工具清单${scopeLabel}：
${JSON.stringify(toolList, null, 2)}

请选出最匹配该语义需求的工具。返回 JSON：{"toolName":"<工具名>","reason":"<简短理由>"}
若无匹配工具，返回 {"toolName":null}

只返回 JSON，不要其他内容。`;

    try {
      const raw = await this.llm.complete(prompt);
      const parsed = this.parseLlmResponse(raw);
      if (!parsed.toolName) return null;
      return {
        toolName: parsed.toolName,
        params: {},
        source: "llm",
        confidence: 0.7,
      };
    } catch {
      return null;
    }
  }

  /** 从 registry 取全量 domain 工具清单（兜底路径）。 */
  private getFullDomainManifests(): CandidateManifest[] {
    const manifests = this.registry.forPlanner(["domain"]);
    return manifests.map((m) => ({
      name: m.name,
      description: m.description,
      triggers: m.whenToUse.triggers,
    }));
  }

  async resolveBatch(needs: SemanticNeed[], ctx: BizContext): Promise<ResolvedTool[]> {
    // 简单实现：逐个解析（未来可优化为一次 LLM 调用处理多个 need）
    const results: ResolvedTool[] = [];
    for (const need of needs) {
      const resolved = await this.resolve(need, ctx);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /** 解析 LLM 返回的 JSON（容错：提取第一个 {...} 块）。 */
  private parseLlmResponse(raw: string): { toolName: string | null; reason?: string } {
    try {
      // 尝试直接 parse
      return JSON.parse(raw) as { toolName: string | null; reason?: string };
    } catch {
      // 提取第一个 JSON 对象
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as { toolName: string | null; reason?: string };
        } catch {
          return { toolName: null };
        }
      }
      return { toolName: null };
    }
  }
}

/**
 * 把 EmbeddingToolRouter 的候选转换为 LlmToolResolver 的 candidateProvider。
 *
 * 使用方式（resolver-factory 装配）：
 *   const candidateProvider = makeEmbeddingCandidateProvider(router);
 *   new LlmToolResolver({ registry, llm, candidateProvider });
 */
export function makeEmbeddingCandidateProvider(
  router: { retrieve(query: string, topK?: number): Promise<CandidateTool[]> },
  topK = 10,
): (need: SemanticNeed) => Promise<CandidateManifest[] | null> {
  return async (need: SemanticNeed) => {
    const query = need.description ? `${need.semantic} ${need.description}` : need.semantic;
    const candidates = await router.retrieve(query, topK);
    if (candidates.length === 0) return null;
    return candidates.map((c) => ({
      name: c.name,
      description: `${c.title}（${c.desc}）`,
    }));
  };
}
