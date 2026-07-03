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
export type ResolveSource = "index" | "llm" | "fallback";

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
