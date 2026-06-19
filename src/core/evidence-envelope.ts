/**
 * EvidenceEnvelope：统一取证输出规范（C 层 —— 平台定义类型 + helper）。
 *
 * 来自精益专家洞察："MCP 取证数据加时间戳和置信度标注，让模型知道是 3 分钟前实测
 * 还是昨天班次汇总——这直接影响专家是否敢基于它做决策"。
 *
 * 平台只定义类型 + 校验/构造 helper；应用工具（domain.* 的查询工具、kb、web）负责填充。
 * LLM 在 ReAct 循环里读到 freshness=historical、confidence=estimated 时会自动更谨慎。
 */

/** 数据时效性。LLM 据此判断证据可用程度。 */
export type Freshness = "realtime" | "shift" | "daily" | "weekly" | "historical";

/** 置信度分级。 */
export type Confidence = "measured" | "estimated" | "inferred";

/** 证据来源系统。 */
export type SourceSystem =
  | "MES"
  | "MOM"
  | "ERP"
  | "PLM"
  | "EHS"
  | "obsidian"
  | "web:tavily"
  | "web:fetch"
  | "llm"
  | string; // 应用可扩展（如 "scada" / "iot"）

/**
 * 统一取证信封。所有取证类工具（domain.* 查询、kb、web）的 output 必须包成此结构。
 */
export interface EvidenceEnvelope<T = unknown> {
  /** 实际数据负载。 */
  data: T;
  /** 数据时效性。realtime（秒级）/ shift（当前班次）/ daily / weekly / historical。 */
  freshness: Freshness;
  /** 数据采集时间（ISO 8601 字符串）。 */
  capturedAt: string;
  /** 置信度。measured（实测）/ estimated（估算）/ inferred（推断）。 */
  confidence: Confidence;
  /** 来源信息。 */
  source: {
    /** 来源系统标识（MES/MOM/ERP/obsidian/web:tavily/...）。 */
    system: SourceSystem;
    /** 来源明细（URI/API path/doc path/query）。 */
    provenance: string;
  };
  /** 数据注意事项（如"采样率 1/min" / "不含外协产线"）。LLM 据此降权。 */
  caveat?: string;
}

/**
 * 构造一个 EvidenceEnvelope（带校验）。
 * 应用工具用此 helper 而非手写对象，保证字段完整性。
 *
 * @example
 *   return wrapEvidence({ oee: 0.65 }, {
 *     freshness: "realtime",
 *     confidence: "measured",
 *     system: "MES",
 *     provenance: "/api/oee/line-A",
 *   });
 */
export function wrapEvidence<T>(
  data: T,
  meta: {
    freshness: Freshness;
    confidence: Confidence;
    system: SourceSystem;
    provenance: string;
    capturedAt?: string;
    caveat?: string;
  },
): EvidenceEnvelope<T> {
  return {
    data,
    freshness: meta.freshness,
    capturedAt: meta.capturedAt ?? new Date().toISOString(),
    confidence: meta.confidence,
    source: { system: meta.system, provenance: meta.provenance },
    ...(meta.caveat ? { caveat: meta.caveat } : {}),
  };
}

/**
 * 校验对象是否符合 EvidenceEnvelope 结构（运行时松校验）。
 * 用于 MCP/工具输出进入 ReAct 上下文前的把关。
 */
export function isEvidenceEnvelope(v: unknown): v is EvidenceEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    "data" in o &&
    "freshness" in o &&
    typeof o.freshness === "string" &&
    "capturedAt" in o &&
    typeof o.capturedAt === "string" &&
    "confidence" in o &&
    typeof o.confidence === "string" &&
    "source" in o &&
    typeof o.source === "object" &&
    o.source !== null
  );
}

/**
 * 按 EvidenceEnvelope 的元数据生成"证据强度"权重（0-1）。
 * LLM 不直接读此值，但应用可用它做 precondition 判断（如"证据强度 <0.5 时禁止收尾"）。
 *
 * 权重 = freshness 权重 × confidence 权重。
 * freshness: realtime=1.0, shift=0.85, daily=0.7, weekly=0.55, historical=0.4
 * confidence: measured=1.0, estimated=0.7, inferred=0.4
 */
export function evidenceStrength(env: EvidenceEnvelope): number {
  const freshnessWeight: Record<Freshness, number> = {
    realtime: 1.0,
    shift: 0.85,
    daily: 0.7,
    weekly: 0.55,
    historical: 0.4,
  };
  const confidenceWeight: Record<Confidence, number> = {
    measured: 1.0,
    estimated: 0.7,
    inferred: 0.4,
  };
  return freshnessWeight[env.freshness] * confidenceWeight[env.confidence];
}

/**
 * 把 EvidenceEnvelope 压成 LLM 友好的简短描述（喂进 prepareStep 注入）。
 * 例："[MES 实测 2026-06-19T22:00Z conf=measured] OEE=0.65"
 */
export function summarizeEvidence(env: EvidenceEnvelope): string {
  const ts = env.capturedAt.slice(0, 16).replace("T", " ");
  const parts = [
    `[${env.source.system} ${env.freshness} ${ts}Z conf=${env.confidence}]`,
  ];
  if (env.caveat) parts.push(`(注意：${env.caveat})`);
  return parts.join(" ");
}
