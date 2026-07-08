/**
 * KpiResolver —— 指标级语义解析器（L1 KPI 体系增强）。
 *
 * 设计见 07-mestar-integration-spec.md §4（KpiResolver）。
 *
 * 与 IndexToolResolver / LlmToolResolver 的区别：
 *   - 后者解析"语义 → 工具调用"（工具级）
 *   - KpiResolver 解析"语义 → 指标可计算性"（指标级）
 *
 * 当用户问"OEE 是多少"时：
 *   ① 如果有能算 OEE 的工具 → 让后续 resolver 处理（KpiResolver 返回 null）
 *   ② 如果没有工具，但 KPI 体系知道"OEE 缺设备停机时长" → 产出 composite:
 *        ResolvedTool.composite.kind = "kpi_unavailable"
 *        prepare-step 据此产出可解释的降级（"OEE 无法精确计算，因为..."）
 *
 * 链路位置：作为 CompositeToolResolver 的**第一层**（在 Index 之前），
 * 因为它不是"找工具"，而是"理解指标"，理解后就能解释降级。
 */
import type { McpClient, McpToolCallResult } from "../tools/mcp/mcp-client.js";
import type { KpiCatalogCache, KpiDescriptor } from "../tools/mcp/kpi-catalog-cache.js";
import type { BizContext, SemanticNeed } from "./types.js";
import type { ResolvedTool, ResolvedComposite, KpiMissingDimension, ToolResolver } from "./tool-resolver.js";

/** KpiResolver 构造选项。 */
export interface KpiResolverOptions {
  /** MCP 客户端（调 kpi.assess / kpi.guide 用）。 */
  client: McpClient;
  /** KPI 目录缓存（预热后提供 KPI 元数据）。 */
  kpiCatalog: KpiCatalogCache;
}

/** mestar.kpi.assess 返回结构。 */
interface KpiAssessResult {
  kpi: string;
  /** 是否可计算。兼容 calculable（旧）和 canCalculate（新）。 */
  calculable: boolean;
  /** 已具备的数据维度。 */
  available?: string[];
  /** 缺失的数据维度（含原因）。兼容 missing（旧）和 missingInputs（新）。 */
  missing?: Array<{ field: string; reason?: string; suggestedSource?: string }>;
  /** 可读性结论。 */
  summary?: string;
  /** assess 返回的缺口说明（新协议）。 */
  gaps?: string[];
  /** assess 返回的告警（新协议）。 */
  warnings?: string[];
  /** 推荐工具（新协议，可能为空表示无 MCP 工具）。 */
  recommendedTools?: string[];
  /** 就绪状态（java_only / mcp_ready 等）。 */
  readinessStatus?: string;
  /** MCP 工具数量。 */
  mcpToolCount?: number;
  /** Java 证据数量（有 Java 实体但未暴露为 MCP 工具）。 */
  javaEvidenceCount?: number;
}

/** mestar.kpi.guide 返回结构。 */
interface KpiGuideResult {
  kpi: string;
  /** 计算引导（公式/步骤，人可读）。兼容 guide（旧）和 calculationGuide（新）。 */
  guide?: string;
  /** 替代方案建议。兼容 alternatives（旧，数组）和（新协议无此字段时取 gaps）。 */
  alternatives?: string[];
}

// payload 是动态 JSON，用 narrowing 把 unknown 收敛到具体类型，避免污染 KpiAssessResult
function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function pickStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}
function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * KPI 指标级解析器。
 *
 * 工作流：
 *   1. 在 KpiCatalogCache 中查 semantic → 命中则认为是 KPI 类需求
 *   2. 调 kpi.assess 评估可计算性
 *      - calculable=true → 返回 null（让后续 resolver 找具体工具）
 *      - calculable=false → 调 kpi.guide 取降级引导，产出 composite
 */
export class KpiResolver implements ToolResolver {
  private readonly client: McpClient;
  private readonly kpiCatalog: KpiCatalogCache;

  constructor(opts: KpiResolverOptions) {
    this.client = opts.client;
    this.kpiCatalog = opts.kpiCatalog;
  }

  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    // KPI 目录未就绪 → 跳过（让后续 resolver 处理）
    if (!this.kpiCatalog.isReady()) return null;

    // ① 在 KPI 目录中查 semantic
    const kpi = this.kpiCatalog.findBySemantic(need.semantic);
    if (!kpi) return null; // 非 KPI 类需求，让后续 resolver 处理

    // ② 调 kpi.assess 评估可计算性
    const assess = await this.callAssess(kpi);
    if (!assess) return null; // assess 调用失败，让后续 resolver 处理

    // ③ 可计算 → 让后续 resolver 找具体工具
    if (assess.calculable) return null;

    // ④ 不可计算，但 assess 返回了推荐工具 → 放行（让后续 resolver 尝试这些工具）
    //    这避免 KpiResolver 短路拦截掉 mestar 明确推荐的降级工具。
    //    场景：mestar 说"OEE 不可直接算，但有 throughput 工具可近似"
    const hasRecommendedTools = (assess.recommendedTools ?? []).length > 0;
    if (hasRecommendedTools) return null;

    // ⑤ 不可计算且无推荐工具 → 调 kpi.guide 取降级引导
    const guide = await this.callGuide(kpi);

    // ⑥ 产出 composite（prepare-step 据此产出可解释降级）
    const composite = this.buildComposite(kpi, assess, guide);
    return {
      // toolName 用占位标识，prepare-step 看到 composite 就不会真调工具
      toolName: `kpi.unavailable.${kpi.id}`,
      params: {},
      source: "kpi",
      confidence: 0.9, // KPI 体系的评估结果可信度高
      composite,
    };
  }

  async resolveBatch(needs: SemanticNeed[], ctx: BizContext): Promise<ResolvedTool[]> {
    const results: ResolvedTool[] = [];
    for (const need of needs) {
      const resolved = await this.resolve(need, ctx);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /** 调 mestar.kpi.assess。 */
  private async callAssess(kpi: KpiDescriptor): Promise<KpiAssessResult | null> {
    try {
      const result: McpToolCallResult = await this.client.callTool("mestar.kpi.assess", {
        metricId: kpi.id,
      });
      return this.parseAssessResult(result, kpi);
    } catch (e) {
      console.warn(
        `[kpi-resolver] kpi.assess 调用失败（${kpi.id}）：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** 解析 kpi.assess 返回（structuredContent / text 双路）。兼容新旧协议字段。 */
  private parseAssessResult(result: McpToolCallResult, kpi: KpiDescriptor): KpiAssessResult | null {
    // isError=true 直接返回（assess 工具调用失败）
    if (result.isError) return null;

    // 抽取 JSON payload（structuredContent 优先，否则 text 解析）
    const payload = this.extractPayload(result);
    if (!payload) return null;

    // 兼容新旧协议：calculable（旧） | canCalculate（新）
    const calculable = payload.calculable ?? payload.canCalculate;
    if (typeof calculable !== "boolean") return null;

    // missing: 旧协议是对象数组，新协议 missingInputs 是字符串数组
    const missingRaw = payload.missing ?? payload.missingInputs;
    const missing = Array.isArray(missingRaw)
      ? missingRaw.map((m) =>
          typeof m === "string" ? { field: m } : { field: m.field, reason: m.reason, suggestedSource: m.suggestedSource },
        )
      : undefined;

    // metric 子对象（新协议把 readiness/mcpToolCount 嵌套在此）
    const metric = (payload.metric ?? {}) as Record<string, unknown>;

    return {
      kpi: pickString(payload.kpi) ?? kpi.id,
      calculable,
      available: pickStringArray(payload.available),
      missing,
      summary: pickString(payload.summary),
      // 新协议字段（gaps/warnings/recommendedTools 在顶层）
      gaps: pickStringArray(payload.gaps),
      warnings: pickStringArray(payload.warnings),
      recommendedTools: pickStringArray(payload.recommendedTools),
      // readinessStatus/mcpToolCount/javaEvidenceCount 嵌套在 metric 对象内
      readinessStatus: pickString(payload.readinessStatus) ?? pickString(metric.readinessStatus),
      mcpToolCount: pickNumber(payload.mcpToolCount) ?? pickNumber(metric.mcpToolCount),
      javaEvidenceCount: pickNumber(payload.javaEvidenceCount) ?? pickNumber(metric.javaEvidenceCount),
    };
  }

  /** 调 mestar.kpi.guide。 */
  private async callGuide(kpi: KpiDescriptor): Promise<KpiGuideResult | null> {
    try {
      const result: McpToolCallResult = await this.client.callTool("mestar.kpi.guide", {
        metricId: kpi.id,
      });
      return this.parseGuideResult(result, kpi);
    } catch (e) {
      console.warn(
        `[kpi-resolver] kpi.guide 调用失败（${kpi.id}）：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** 解析 kpi.guide 返回。兼容新旧协议字段。 */
  private parseGuideResult(result: McpToolCallResult, kpi: KpiDescriptor): KpiGuideResult | null {
    if (result.isError) return null;
    const payload = this.extractPayload(result);
    if (!payload) return null;

    // guide（旧） | calculationGuide（新）
    const guide = pickString(payload.guide) ?? pickString(payload.calculationGuide);
    // alternatives（旧数组） | gaps（新，作为降级备选说明）
    const alternatives = pickStringArray(payload.alternatives) ?? pickStringArray(payload.gaps);
    if (!guide && !alternatives) return null;

    return {
      kpi: pickString(payload.kpi) ?? kpi.id,
      guide,
      alternatives,
    };
  }

  /**
   * 从 MCP 工具返回中抽取 JSON payload。
   * 优先 structuredContent，否则从 content[].text 解析 JSON。
   * 返回 any（字段动态，由上层做兼容映射）。
   */
  private extractPayload(result: McpToolCallResult): Record<string, unknown> | null {
    // 优先 structuredContent
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (structured && typeof structured === "object") return structured;
    // 兜底：text 解析
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** 组装 ResolvedComposite。 */
  private buildComposite(
    kpi: KpiDescriptor,
    assess: KpiAssessResult,
    guide: KpiGuideResult | null,
  ): ResolvedComposite {
    const missingDimensions: KpiMissingDimension[] = (assess.missing ?? []).map((m) => ({
      field: m.field,
      reason: m.reason,
      suggestedSource: m.suggestedSource,
    }));

    // 判断是"完全不可算"还是"部分可算"
    const hasAvailable = assess.available && assess.available.length > 0;
    const kind = hasAvailable ? "kpi_partial" : "kpi_unavailable";

    // 组装可读性 guidance（融入新协议的 gaps/warnings/readinessStatus）
    const missingFields = missingDimensions.map((m) => m.field);
    const guidanceParts: string[] = [];
    guidanceParts.push(`${kpi.label ?? kpi.id} 无法精确计算`);
    if (missingFields.length > 0) {
      guidanceParts.push(`（缺少：${missingFields.join("、")}）`);
    }
    if (assess.readinessStatus) {
      guidanceParts.push(`。数据源状态：${assess.readinessStatus}`);
      if (assess.readinessStatus === "java_only") {
        guidanceParts.push("（Java 层有实现，但未暴露为 MCP 工具）");
      }
    }
    if (typeof assess.mcpToolCount === "number") {
      guidanceParts.push(`。MCP 可用工具数：${assess.mcpToolCount}`);
    }
    if (assess.gaps && assess.gaps.length > 0) {
      guidanceParts.push(`。缺口：${assess.gaps.join("；")}`);
    }
    if (assess.summary) {
      guidanceParts.push(`。${assess.summary}`);
    }
    const guidance = guidanceParts.join("");

    return {
      kind,
      kpi: kpi.id,
      kpiLabel: kpi.label,
      missingDimensions,
      availableDimensions: assess.available,
      guidance,
      calculationGuide: guide?.guide,
      alternatives: guide?.alternatives,
      // 新协议字段透传（让下游能产出完整的"能力缺口报告"）
      gaps: assess.gaps,
      warnings: assess.warnings,
      readinessStatus: assess.readinessStatus,
      mcpToolCount: assess.mcpToolCount,
      javaEvidenceCount: assess.javaEvidenceCount,
    };
  }
}
