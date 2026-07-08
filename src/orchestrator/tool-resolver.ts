/**
 * ToolResolver 接口定义（L3 工具解析层）。
 *
 * 设计见 apps/nexusops/docs/architecture/02-tool-resolver-design.md。
 * 把 Orchestrator 产出的"语义需求"（如 process_capability）解析为
 * 当前企业环境里的"真实工具调用"（如 quality.cp_cpk 或 mes.capability）。
 *
 * 三档解析策略（按优先级）：
 *   1. 索引命中（快，企业工具索引）
 *   2. LLM 推理（慢，但灵活）
 *   3. 返回 null（数据不可用，分析继续不崩溃）
 */
import type { BizContext, SemanticNeed } from "./types.js";

/** 解析来源。 */
export type ResolveSource = "index" | "llm" | "fallback" | "kpi";

/**
 * KPI 不可算的缺失维度（mestar.kpi.assess 返回，供 prepare-step 可解释降级）。
 *
 * 示例：assessOee 返回 missingDimensions: ["设备停机时长", "标准工时"]，
 * 表示这两个 MES 字段未接入，因此 OEE 无法精确计算。
 */
export interface KpiMissingDimension {
  /** 缺失的字段中文名（如"设备停机时长"）。 */
  field: string;
  /** 缺失原因（如"MES 未接入"、"需要人工录入"）。 */
  reason?: string;
  /** 该字段的来源建议（如"设备 OEE 模块"、"手工录入"）。 */
  suggestedSource?: string;
}

/**
 * 复合解析结果（KpiResolver 产出，表示"指标级"理解而非"工具级"命中）。
 *
 * 当用户问"OEE 是多少"时，可能存在两种情况：
 *   ① 找到能算 OEE 的工具 → 正常 ResolvedTool
 *   ② 工具不存在但能解释为什么不存在 → ResolvedTool.composite.kind = "kpi_unavailable"
 *
 * 第二种让 prepare-step 产出"可解释的降级"而非"工具未找到"的硬错误。
 */
export interface ResolvedComposite {
  /** 复合类型。 */
  kind: "kpi_unavailable" | "kpi_partial" | "kpi_assessed";
  /** 关联的 KPI 标识（如 "oee" / "fpy" / "dpu"）。 */
  kpi: string;
  /** KPI 的中文显示名。 */
  kpiLabel?: string;
  /** 缺失维度（assess 返回，解释为什么不可算）。 */
  missingDimensions?: KpiMissingDimension[];
  /** 已具备维度（部分可算时，列出已有的）。 */
  availableDimensions?: string[];
  /** 可读性结论（喂 LLM，如"OEE 无法精确计算，缺设备停机时长"）。 */
  guidance?: string;
  /** 计算引导（kpi.guide 返回，引导 LLM 用替代方式估算）。 */
  calculationGuide?: string;
  /** 替代方案建议（如"可用设备稼动率近似估算"）。 */
  alternatives?: string[];
  /** assess 返回的缺口说明（新协议，mestar 的"能力缺口报告"）。 */
  gaps?: string[];
  /** assess 返回的告警（如"不要临场猜测 OEE 口径"）。 */
  warnings?: string[];
  /** 就绪状态（java_only / mcp_ready，表示数据源成熟度）。 */
  readinessStatus?: string;
  /** MCP 可用工具数（0 表示完全无工具，需降级）。 */
  mcpToolCount?: number;
  /** Java 证据数（有 Java 实现但未暴露为 MCP 工具的数量）。 */
  javaEvidenceCount?: number;
}

/** 解析结果（语义需求 → 真实工具调用）。 */
export interface ResolvedTool {
  /** 真实工具名，如 "quality.cp_cpk"。 */
  toolName: string;
  /** 映射后的入参（语义参数 → 工具实际入参）。 */
  params: Record<string, unknown>;
  /**
   * 返回字段映射（处理异构格式）。
   * 如工具返回 {cpk: 1.2}，但消费方期望 {value: 1.2}，则 fieldMap = {cpk: "value"}。
   * 支持 dot 路径：{ "indices.cpk": "cpk" }
   */
  fieldMap?: Record<string, string>;
  /** 解析来源。 */
  source: ResolveSource;
  /** 解析置信度（索引命中 1.0，LLM 推理 0.6-0.8）。 */
  confidence: number;
  /**
   * 复合解析结果（KpiResolver 产出）。
   *
   * 存在时表示这次解析不是"找到工具"，而是"指标级理解"：
   * prepare-step 应消费 composite 产出可解释的降级 guidance，
   * 而非按 toolName 调用工具。
   */
  composite?: ResolvedComposite;
}

/** 索引条目（数据文件 data/tool-semantic-index.json 的单元）。 */
export interface IndexEntry {
  /** 真实工具名。 */
  toolName: string;
  /** 语义参数 → 工具入参的映射。 */
  paramMap?: Record<string, string>;
  /** 工具输出 → 语义字段的映射。 */
  fieldMap?: Record<string, string>;
  /** 是否为主工具（同 semantic 多工具时优先）。 */
  primary?: boolean;
}

/**
 * 工具解析层接口。
 */
export interface ToolResolver {
  /**
   * 把语义需求解析为真实工具调用。
   * @param need       语义需求（来自 Orchestrator 的 SemanticNeed）
   * @param context    业务上下文（含已收集证据，辅助 LLM 推理）
   * @returns          解析结果；null 表示该语义在本企业无对应工具
   */
  resolve(need: SemanticNeed, context: BizContext): Promise<ResolvedTool | null>;

  /** 批量解析（一次分析通常有多个 need，批量减少 LLM 调用）。 */
  resolveBatch(needs: SemanticNeed[], context: BizContext): Promise<ResolvedTool[]>;
}

/**
 * 可运行时重载的 ToolResolver（定时刷新用）。
 *
 * CompositeToolResolver.reload() 会遍历子 resolver，对实现了本接口的调 reload()。
 * IndexToolResolver/EmbeddingToolRouter 等带底层索引文件的 resolver 实现；
 * KpiResolver/LlmToolResolver 无状态文件，无需实现。
 */
export interface ReloadableResolver extends ToolResolver {
  /** 重新加载底层索引/状态。 */
  reload(): void;
}
