/**
 * NexusOps 业务阈值 / 临界值集中配置。
 *
 * 设计目的：把散落在各域工具（quality/energy/personnel/scheduling/...）以及
 * orchestrator / skills 中的业务临界数字收敛到一处，便于：
 *   - 按行业/产线/客户调整判定阈值（换部署只需改本文件 + 环境变量）
 *   - 文档化每个数字的业务含义（不再是无名的 0.03 / 0.7 / 0.85）
 *
 * 优先级链（高 → 低）：
 *   1. 环境变量（如 NEXUS_DEFECT_RATE_THRESHOLD）—— 部署期临时调参
 *   2. 本文件 BUSINESS_THRESHOLDS —— 代码内基线
 *
 * 注意：置信度分级（measured/estimated/inferred）在 src/core/evidence-envelope.ts
 * 已有约定（1.0/0.7/0.4），本文件只放业务判定阈值，不重复定义 evidence 分级。
 */

/** 单个业务阈值项的描述结构。 */
export interface BusinessThreshold {
  /** 阈值数值。 */
  value: number;
  /** 业务含义说明（便于运维理解调参影响）。 */
  desc: string;
}

/**
 * 业务阈值基线表（按域分组）。
 *
 * 命名约定：<DOMAIN>_<METRIC>_THRESHOLD，全大写下划线分隔。
 */
export const BUSINESS_THRESHOLDS = {
  /** ── 质量域 ── */
  quality: {
    /** 缺陷率告警阈值（3%）。超过即视为异常需诊断。 */
    defectRate: 0.03,
    /** SPC 失控判定（CPK 低于此值需关注）。 */
    cpkAlarm: 1.33,
  },

  /** ── 能耗域 ── */
  energy: {
    /** 能效比 ≥ 0.85 视为 good。 */
    efficiencyGood: 0.85,
    /** 能效比 ≥ 0.70 视为 warning（低于则 poor）。 */
    efficiencyWarning: 0.7,
    /** 单耗基线（kWh/单位产品），用于偏离对比。 */
    baselineKwhPerUnit: 0.42,
  },

  /** ── 人员域 ── */
  personnel: {
    /** L3+ 持证比例 ≥ 0.80 视为 adequate。 */
    skillAdequate: 0.8,
    /** L3+ 比例 ≥ 0.60 视为 marginal（低于则 inadequate）。 */
    skillMarginal: 0.6,
    /** 疲劳分阈值（≥0.7 告警，建议休息/换班）。 */
    fatigueAlarm: 0.7,
  },

  /** ── 证据置信度分级（与 evidence-envelope.ts 对齐） ── */
  confidence: {
    /** measured 类证据：直接实测，置信度满分。 */
    measured: 1.0,
    /** estimated 类证据：模型推算，置信度高。 */
    estimated: 0.7,
    /** inferred 类证据：LLM 推断，置信度低。 */
    inferred: 0.4,
  },

  /** ── 工具路由 / resolver ── */
  routing: {
    /** 在线 catalog 搜索的置信度基线（低于 Index/LLM 路径）。 */
    catalogSearchOnline: 0.6,
    /** LLM 兜底推断的置信度基线。 */
    llmResolver: 0.7,
    /** resolver 高置信度阈值（≥此值可直接采信）。 */
    highConfidence: 0.7,
  },
} as const;

/**
 * 解析带环境变量覆盖的阈值。
 *
 * @param envKey    环境变量名（如 NEXUS_DEFECT_RATE_THRESHOLD）
 * @param fallback  默认值（来自 BUSINESS_THRESHOLDS）
 * @returns 解析后的数值
 */
export function resolveThreshold(envKey: string, fallback: number): number {
  const envVal = process.env[envKey];
  if (envVal === undefined || envVal === "") return fallback;
  const parsed = Number(envVal);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ── 便捷导出：按域提供命名常量，业务代码直接引用 ──

/** 缺陷率告警阈值。 */
export const DEFECT_RATE_THRESHOLD = resolveThreshold(
  "NEXUS_DEFECT_RATE_THRESHOLD",
  BUSINESS_THRESHOLDS.quality.defectRate,
);

/** 能效 good 阈值。 */
export const ENERGY_EFFICIENCY_GOOD = resolveThreshold(
  "NEXUS_ENERGY_EFFICIENCY_GOOD",
  BUSINESS_THRESHOLDS.energy.efficiencyGood,
);

/** 能效 warning 阈值。 */
export const ENERGY_EFFICIENCY_WARNING = resolveThreshold(
  "NEXUS_ENERGY_EFFICIENCY_WARNING",
  BUSINESS_THRESHOLDS.energy.efficiencyWarning,
);

/** 单耗基线。 */
export const ENERGY_BASELINE_KWH_PER_UNIT = resolveThreshold(
  "NEXUS_ENERGY_BASELINE_KWH",
  BUSINESS_THRESHOLDS.energy.baselineKwhPerUnit,
);

/** L3+ 持证 adequate 阈值。 */
export const SKILL_ADEQUATE_RATIO = resolveThreshold(
  "NEXUS_SKILL_ADEQUATE_RATIO",
  BUSINESS_THRESHOLDS.personnel.skillAdequate,
);

/** L3+ 持证 marginal 阈值。 */
export const SKILL_MARGINAL_RATIO = resolveThreshold(
  "NEXUS_SKILL_MARGINAL_RATIO",
  BUSINESS_THRESHOLDS.personnel.skillMarginal,
);

/** 疲劳分告警阈值。 */
export const FATIGUE_ALARM_THRESHOLD = resolveThreshold(
  "NEXUS_FATIGUE_ALARM_THRESHOLD",
  BUSINESS_THRESHOLDS.personnel.fatigueAlarm,
);

/** 在线 catalog 搜索置信度基线。 */
export const CATALOG_SEARCH_CONFIDENCE = resolveThreshold(
  "NEXUS_CATALOG_SEARCH_CONFIDENCE",
  BUSINESS_THRESHOLDS.routing.catalogSearchOnline,
);

/** LLM 兜底 resolver 置信度基线。 */
export const LLM_RESOLVER_CONFIDENCE = resolveThreshold(
  "NEXUS_LLM_RESOLVER_CONFIDENCE",
  BUSINESS_THRESHOLDS.routing.llmResolver,
);

/** resolver 高置信度阈值（≥此值可直接采信）。 */
export const ROUTING_HIGH_CONFIDENCE = resolveThreshold(
  "NEXUS_ROUTING_HIGH_CONFIDENCE",
  BUSINESS_THRESHOLDS.routing.highConfidence,
);
