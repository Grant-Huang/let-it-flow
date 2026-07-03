/**
 * Orchestrator 核心类型定义（L2 知识层抽象）。
 *
 * 设计见 apps/nexusops/docs/architecture/01-orchestrator-design.md。
 * 这些类型严格对齐 relos 的 RelationObject / ContextBlock 形态，
 * 让未来切到真实 relos 时是"换数据源"而非"换结构"。
 *
 * source 字段当前恒为 "mock"，未来支持 "relos" / "cache" / "cache_stale"。
 */

/** 知识来源。relos（在线）/ cache（缓存）/ cache_stale（过期缓存）/ mock。 */
export type KnowledgeSource = "relos" | "cache" | "cache_stale" | "mock";

/** 业务上下文（所有查询方法的公共入参）。 */
export interface BizContext {
  /** 场景（mock 用，真实环境可缺省）。 */
  scenarioId?: "normal" | "anomaly" | "crisis";
  /** 产线/设备/工单等业务实体标识。 */
  line?: string;
  /** 当前已收集的证据快照（供 Orchestrator 判断"证据是否充分"）。 */
  collectedEvidence?: Record<string, unknown>;
  /** 分析意图（LLM 当前在想什么）。 */
  intent?: string;
}

/** 业务语义需求（不含工具名，由 ToolResolver 解析为真实工具）。 */
export interface SemanticNeed {
  /** 业务语义标识，如 "process_capability" / "oee" / "causal_chain"。 */
  semantic: string;
  /** 该需求是否为硬需求（缺失则 phase 阻塞）。 */
  required: boolean;
  /** 兜底提示（当 ToolResolver 无法解析时给 LLM 的建议）。 */
  fallbackHints?: string[];
  /** 人类可读的需求描述（注入 prompt 帮 LLM 理解）。 */
  description?: string;
}

/** 方法论阶段。 */
export interface Phase {
  /** 阶段标识，如 "D" / "M" / "diagnose" / "analyze"。 */
  id: string;
  /** 阶段名称，如 "Define（定义）"。minimal 粒度时可缺省。 */
  name?: string;
  /** 阶段目标（业务语义）。minimal 粒度时可缺省。 */
  goal?: string;
  /** 该阶段需要的语义数据需求（不含工具名！）。 */
  requiredData: SemanticNeed[];
  /** 阶段级别的软提示（工具选择建议，非强制）。 */
  guidance?: string;
  /** 该 phase 规则的置信度（可选，细粒度置信度）。 */
  confidence?: number;
  /** 是否为硬阻塞点（true = 证据不足不能进入下一阶段）。 */
  blocking?: boolean;
}

/**
 * 方法论骨架（D11 C 混合粒度的载体）。
 *
 * granularity:
 *   - "full"    ：完整结构化（DMAIC/OEE 等成熟方法论），phases 含详细 goal/requiredData/guidance
 *   - "minimal" ：最小骨架（general_analysis 等开放场景），phases 只有阶段名 + 关键语义需求
 */
export interface Methodology {
  /** 方法论主题，如 "dmaic" / "oee_diagnose" / "general_analysis"。 */
  topic: string;
  /** 方法论的可信度（0-1）。LLM 据此判断是否严格遵循。 */
  confidence: number;
  /** 知识来源。 */
  source: KnowledgeSource;
  /** 粒度。 */
  granularity: "full" | "minimal";
  /** 阶段序列。 */
  phases: Phase[];
  /** 方法论级别的指导语（注入 system prompt 的软提示）。 */
  guidance?: string;
}

/** 证据需求项。 */
export interface EvidenceRequirement {
  /** 语义需求标识（与 SemanticNeed.semantic 对齐）。 */
  semantic: string;
  /** 该证据的最低置信度（低于此值视为"证据不足"）。 */
  minConfidence: number;
  /** 该证据是否必须存在（vs 可选增强）。 */
  required: boolean;
}

/** 证据契约（governance 校验依据）。 */
export interface EvidenceContract {
  /** 结论标识，如 "root_cause_identified" / "capability_sufficient" / "D_complete"。 */
  conclusion: string;
  /** 支撑该结论所需的证据项。 */
  requiredEvidence: EvidenceRequirement[];
  /** 结论成立所需的最低平均置信度。 */
  minConfidence: number;
  /** 契约来源。 */
  source: KnowledgeSource;
  /** 备注说明。 */
  notes?: string;
}

/** 鱼骨图因素条目。 */
export interface FactorEntry {
  /** 因素描述。 */
  factor: string;
  /** 该因素的置信度。 */
  confidence: number;
  /** 证据引用（指向 mock 字段或真实工具输出，增强可追溯性）。 */
  evidenceRefs?: string[];
}

/** 5Why 因果链。 */
export interface WhyChain {
  method: "5why";
  layers: string[];
  rootCause: string;
  /** 该链的置信度。 */
  confidence: number;
}

/** 因果链（替代 mock 的 CAUSAL_CHAIN）。 */
export interface CausalChain {
  /** 症状描述（与 quality.defectRate / oee.decompose 等输出对齐）。 */
  symptom: string;
  /** 5Why 逐层追问链。 */
  chains: WhyChain[];
  /** 鱼骨图 5M1E 六分支，每分支带证据引用。 */
  fishbone: {
    man: FactorEntry[];
    machine: FactorEntry[];
    material: FactorEntry[];
    method: FactorEntry[];
    environment: FactorEntry[];
    measurement: FactorEntry[];
  };
  /** 首要嫌疑（鱼骨图中置信度最高的分支）。 */
  topSuspect?: string;
  /** 来源。 */
  source: KnowledgeSource;
}

/** relos RelationObject（对齐 relos 开发者指南 §7.1）。 */
export interface RelationObject {
  /** UUID。 */
  id: string;
  /** relos 命名规范：DOMAIN__VERB__DOMAIN。 */
  relation_type: string;
  source_node_id: string;
  source_node_type: string;
  target_node_id: string;
  target_node_type: string;
  /** 置信度 0-1。 */
  confidence: number;
  /** bootstrap/interview/pretrain/runtime。 */
  knowledge_phase: "bootstrap" | "interview" | "pretrain" | "runtime";
  /** 来源（决定置信度区间）。 */
  provenance: "manual_engineer" | "mes_structured" | "llm_extracted" | "inference";
  /** 半衰期（天）。 */
  half_life_days?: number;
  /** pending_review/active/conflicted/archived。 */
  status: "pending_review" | "active" | "conflicted" | "archived";
  /** 业务扩展（nexusops mock 特有）。 */
  properties?: {
    /** 适用场景过滤。 */
    appliesScenario?: Array<"normal" | "anomaly" | "crisis">;
    /** 适用产线过滤。 */
    appliesLine?: string[];
    /** 触发症状。 */
    symptom?: string;
    /** 证据引用（指向 scenarios.ts 字段）。 */
    evidenceRefs?: string[];
    /** 5Why 逐层链。 */
    causalLayers?: string[];
    /** 根本原因。 */
    rootCause?: string | null;
    /** 鱼骨图（5M1E，字符串数组形态，对应现有 CAUSAL_CHAIN.fishbone）。 */
    fishbone?: {
      man?: string[];
      machine?: string[];
      material?: string[];
      method?: string[];
      environment?: string[];
      measurement?: string[];
    };
  };
}

/** 工具清单条目（syncToolIndex 的入参）。 */
export interface ToolManifest {
  /** 工具名。 */
  name: string;
  /** 语义标签。 */
  semanticTags?: string[];
  /** 描述。 */
  description: string;
  /** 调用时机。 */
  whenToUse?: {
    triggers: string[];
    notFor: string[];
  };
}

/**
 * Orchestrator 接口（编排知识源抽象）。
 *
 * relos 是远端实现，MockOrchestrator 是本地兜底。
 * 所有方法返回带 confidence + source 的结构，供 LLM 调整信任度。
 */
export interface Orchestrator {
  /** 按业务主题取方法论骨架（带置信度）。LLM 据此编排工具调用序列。 */
  getMethodology(topic: string, context: BizContext): Promise<Methodology | null>;

  /** 取"某结论需要什么证据"的业务契约（驱动动态 precondition）。 */
  getEvidenceContract(conclusion: string, context: BizContext): Promise<EvidenceContract | null>;

  /** 取因果链知识（替代 mock 的 CAUSAL_CHAIN）。 */
  getCausalChain(symptom: string, context: BizContext): Promise<CausalChain | null>;

  /** 回写：把企业的工具集索引同步给 relos（双向支持的"写"方向）。 */
  syncToolIndex(manifest: ToolManifest[]): Promise<void>;
}
