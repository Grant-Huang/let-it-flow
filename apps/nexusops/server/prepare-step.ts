/**
 * NexusOps prepareStep 钩子（E+V 层内容 —— 应用注入，harness 每步前调用）。
 *
 * 两个职责（集中在一个 prepareStep 里实现，见计划决策 #2）：
 *   1. 动态裁工具（activeTools）：扫描已执行 trace 的 toolCall 工具名，推断当前
 *      诊断域，只保留该域 + core 通用工具 + nexus 收尾工具，裁掉无关 domain。
 *      降幻觉、提一致性（工具越多 LLM 越易跑偏）。
 *   2. every_step precondition 提示注入：调用 collectEveryStepReminders，把
 *      "取证不足"的提示注入 system 字段，让 LLM 在下一步补取证（而非拖到 finalize）。
 *
 * 触发纪律：只在"已识别出主导域"时裁工具，否则返回全部工具（避免过早收窄）。
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { PrepareStepContext, PrepareStepResult } from "../../../src/agent/types.js";
import { collectEveryStepReminders } from "./preconditions.js";
import { evaluateEvidenceGate } from "../../../src/agent/evidence-gate.js";
import type { Orchestrator, BizContext, Methodology } from "../../../src/orchestrator/types.js";

/** NexusOps domain 工具前缀（按工具名第一个点分段）。 */
const DOMAIN_PREFIXES = [
  "oee",
  "equipment",
  "quality",
  "process",
  "energy",
  "schedule",
  "material",
] as const;

/** core 通用工具（裁域时始终保留）。 */
const CORE_KEEP = new Set(["core.web_search", "core.web_fetch", "core.knowledge_base"]);

/** nexus 收尾/建议工具（始终保留）。 */
const NEXUS_KEEP = new Set(["nexus_finalize", "nexus_advise"]);

/** skill 工具（始终保留，沉淀流程跨域复用）。 */
const SKILL_PREFIX = "skill.";

/** 主导域判定阈值：某域工具调用占比超过此值则认定主导（严格多数，平局不算）。 */
const DOMINANT_RATIO = 0.5;

/**
 * 从已执行 trace 推断当前主导诊断域。
 * @returns 主导域前缀（如 "oee"），无主导时返回 undefined。
 */
function detectDominantDomain(steps: PrepareStepContext["steps"]): string | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      if (tc.rejected) continue;
      const prefix = tc.toolName.split(".")[0];
      if (!prefix) continue;
      // 只统计 domain 工具（排除 core/nexus/skill）
      if ((DOMAIN_PREFIXES as readonly string[]).includes(prefix)) {
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        total++;
      }
    }
  }
  if (total === 0) return undefined;
  let dominant: string | undefined;
  let dominantCount = 0;
  for (const [prefix, count] of counts) {
    if (count > dominantCount) {
      dominant = prefix;
      dominantCount = count;
    }
  }
  if (!dominant) return undefined;
  // 主导域工具调用占比必须严格超过半数（平局不算主导，避免误裁）
  if (dominantCount / total <= DOMINANT_RATIO) return undefined;
  return dominant;
}

/** NexusOps prepareStep 配置选项。 */
export interface PrepareStepConfig {
  /** harness 暴露给 LLM 的全部工具名（用于裁剪后返回 activeTools）。 */
  allToolNames: string[];
  /** 收尾前证据评估模型（主力模型）。缺省则不做语义评估。 */
  evidenceGateModel?: LanguageModel;
  /** 评估模型兼容模式。 */
  evidenceGateCompatMode?: boolean;
  /** 编排知识层（注入方法论指导；缺省则不注入）。 */
  orchestrator?: Orchestrator;
  /** 意图分类模型（首步用，把用户意图分类到方法论 topic）。缺省则降级为关键词匹配。 */
  topicClassifyModel?: LanguageModel;
  /** 意图分类模型兼容模式。 */
  topicClassifyCompatMode?: boolean;
}

/**
 * 构造 NexusOps 的 prepareStep 函数。
 *
 * @param allToolNamesOrConfig  全部工具名数组（向后兼容）或完整配置对象
 * @param evidenceGateModel     收尾前证据评估模型（向后兼容）
 * @param evidenceGateCompatMode 评估模型兼容模式（向后兼容）
 * @returns  prepareStep 函数，注入 harness 的 HarnessConfig.prepareStep
 */
export function buildNexusPrepareStep(
  allToolNamesOrConfig: string[] | PrepareStepConfig,
  evidenceGateModel?: LanguageModel,
  evidenceGateCompatMode?: boolean,
): (ctx: PrepareStepContext) => Promise<PrepareStepResult | undefined> | PrepareStepResult | undefined {
  // 向后兼容：数组形态 → 转为配置对象
  const config: PrepareStepConfig = Array.isArray(allToolNamesOrConfig)
    ? { allToolNames: allToolNamesOrConfig, evidenceGateModel, evidenceGateCompatMode }
    : allToolNamesOrConfig;
  const allToolNames = config.allToolNames;
  const gateModel = config.evidenceGateModel;
  const gateCompat = config.evidenceGateCompatMode;
  const orchestrator = config.orchestrator;
  const topicClassifyModel = config.topicClassifyModel;
  const topicClassifyCompatMode = config.topicClassifyCompatMode;

  // 缓存首步注入的方法论（避免重复查询）
  let cachedMethodology: Methodology | null | undefined;

  return async (ctx: PrepareStepContext): Promise<PrepareStepResult | undefined> => {
    const result: PrepareStepResult = {};

    // 0. 首步注入 Orchestrator 方法论指导（Phase 4.1）
    if (orchestrator && ctx.stepNumber === 1) {
      const guide = await buildMethodologyGuidance(
        orchestrator,
        ctx.intent,
        cachedMethodology,
        topicClassifyModel,
        topicClassifyCompatMode,
      );
      if (cachedMethodology === undefined) cachedMethodology = guide.methodology;
      if (guide.system) {
        result.system = guide.system;
      }
    }

    // 1. 动态裁工具：识别主导域后只保留相关工具
    const dominant = detectDominantDomain(ctx.steps);
    if (dominant) {
      result.activeTools = allToolNames.filter((name) => {
        const prefix = name.split(".")[0];
        return (
          prefix === dominant ||
          CORE_KEEP.has(name) ||
          NEXUS_KEEP.has(name) ||
          name.startsWith(SKILL_PREFIX)
        );
      });
    }

    // 2. every_step precondition 提示注入
    const reminders = collectEveryStepReminders(ctx.steps);
    if (reminders.length > 0) {
      const reminderText = `## 前置条件提醒（每步检查）\n${reminders.map((r) => `- ${r}`).join("\n")}\n\n请在下一步优先补齐上述取证，不要在证据不足时给结论。`;
      result.system = result.system ? `${result.system}\n\n${reminderText}` : reminderText;
    }

    // 3. 收尾意图检测 + 证据充分性评估（语义级，主力模型）
    if (gateModel) {
      const gateVerdict = await tryEvaluateEvidenceGate(ctx, gateModel, gateCompat);
      if (gateVerdict) {
        applyGateVerdict(gateVerdict, result, allToolNames);
      }
    }

    if (!result.activeTools && !result.system) return undefined;
    return result;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator 方法论指导注入（Phase 4.1）
// ─────────────────────────────────────────────────────────────────────────────

/** 从用户意图推断方法论 topic。 */
function inferMethodologyTopic(intent: string): string {
  const lower = intent.toLowerCase();
  if (/dmaic|6sigma|六西格玛|sigma|dpmo/.test(lower)) return "dmaic";
  if (/oee|综合效率|设备综合效率/.test(lower)) return "oee_diagnose";
  if (/停机|故障|宕机|downtime/.test(lower)) return "downtime_root_cause";
  if (/七大浪费|waste|精益/.test(lower)) return "waste_audit";
  if (/能耗|能源|energy|电/.test(lower)) return "energy_analysis";
  if (/16949|内审|符合性|审核|audit/.test(lower)) return "qs16949_audit";
  if (/成本|cost/.test(lower)) return "cost_summary";
  if (/多视角|多维度|rca|根因/.test(lower)) return "multi_perspective_rca";
  return "general_analysis";
}

/** 构造方法论指导 system prompt。 */
async function buildMethodologyGuidance(
  orchestrator: Orchestrator,
  intent: string,
  cached: Methodology | null | undefined,
  classifyModel?: LanguageModel,
  classifyCompatMode?: boolean,
): Promise<{ system: string | undefined; methodology: Methodology | null }> {
  // 已缓存则直接用
  if (cached !== undefined) {
    return { system: cached ? formatMethodologyPrompt(cached) : undefined, methodology: cached };
  }

  // 优先用 LLM 分类（语义级，覆盖关键词匹配的盲区）
  let topic: string;
  if (classifyModel) {
    const llmTopic = await classifyMethodologyTopicWithLLM(intent, {
      model: classifyModel,
      compatMode: classifyCompatMode,
    });
    topic = llmTopic ?? inferMethodologyTopic(intent); // LLM 失败降级为关键词
  } else {
    topic = inferMethodologyTopic(intent); // 无分类模型，直接关键词匹配
  }

  const ctx: BizContext = { scenarioId: undefined, line: undefined };
  try {
    const methodology = await orchestrator.getMethodology(topic, ctx);
    return { system: methodology ? formatMethodologyPrompt(methodology) : undefined, methodology };
  } catch {
    // orchestrator 查询失败不阻断（降级为无指导）
    return { system: undefined, methodology: null };
  }
}

/**
 * 用 LLM 把用户意图分类到方法论 topic。
 *
 * 比关键词匹配更鲁棒：能理解"效率不行"="oee_diagnose"、"老是坏"="downtime_root_cause" 等
 * 非字面匹配的意图。失败/超时返回 null（调用方降级为关键词匹配）。
 *
 * 设计（与 narrate-pass / review-pass 对齐，轻量模型一次性 generateText）：
 *   - 纯文本 prompt + 纯文本输出（只返回 topic id，兼容弱 provider）
 *   - 受控词表（只允许返回预定义 topic，避免 LLM 编造）
 */
async function classifyMethodologyTopicWithLLM(
  intent: string,
  options: { model: LanguageModel; compatMode?: boolean },
): Promise<string | null> {
  const { model, compatMode = false } = options;
  const system = [
    "你是运营分析方法论分类器。把用户的分析请求分类到最匹配的方法论 topic。",
    "只输出一个 topic id（从下面的列表选），不要任何解释或其他文字：",
    ...SUPPORTED_TOPICS.map((t) => `- ${t.id}：${t.desc}`),
  ].join("\n");
  const user = `用户请求：${intent}`;

  try {
    const callArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
      : { system, messages: [{ role: "user" as const, content: user }] };

    const { text } = await generateText({
      model,
      ...callArgs,
      temperature: 0,
      maxOutputTokens: 30,
    });

    const cleaned = text.trim().toLowerCase();
    // 精确匹配受控词表
    const hit = SUPPORTED_TOPICS.find((t) => t.id === cleaned);
    if (hit) return hit.id;
    // 容错：LLM 可能输出多余文字，尝试提取 topic id
    for (const t of SUPPORTED_TOPICS) {
      if (cleaned.includes(t.id)) return t.id;
    }
    return null;
  } catch {
    return null;
  }
}

/** 支持的方法论 topic 受控词表（与 Orchestrator 的 getMethodology 对齐）。 */
const SUPPORTED_TOPICS: ReadonlyArray<{ id: string; desc: string }> = [
  { id: "dmaic", desc: "DMAIC / 6Sigma / 六西格玛 / DPMO / Cpk 改善项目" },
  { id: "oee_diagnose", desc: "OEE 诊断 / 综合效率 / 可用率 / 表现率 / 质量率" },
  { id: "downtime_root_cause", desc: "停机 / 故障 / 宕机 / MTBF / MTTR 根因" },
  { id: "waste_audit", desc: "七大浪费 / 精益 / VSM 价值流审计" },
  { id: "energy_analysis", desc: "能耗 / 能源 / 功率 / 节能分析" },
  { id: "qs16949_audit", desc: "IATF 16949 内审 / 过程审核 / 符合性评估" },
  { id: "cost_summary", desc: "成本 / 损失 / 经济性 / 费用汇总" },
  { id: "multi_perspective_rca", desc: "多视角根因 / RCA / 鱼骨图 / FMEA" },
  { id: "general_analysis", desc: "通用分析（不属于以上任何一类时使用）" },
];

/** 把方法论格式化为 system prompt 片段。 */
function formatMethodologyPrompt(m: Methodology): string {
  const sourceLabel = m.source === "mock" ? "（模拟知识 source=mock，可参考但允许自主判断）" : "";
  const phasesText = m.phases?.length
    ? `\n### 阶段路线图（严格按顺序执行）\n${m.phases.map((p, i) => {
        const reqData = p.requiredData?.length
          ? `\n  必取证：${p.requiredData.map((d) => d.semantic).join("、")}`
          : "";
        return `${i + 1}. **${p.id}**：${p.goal}${reqData}`;
      }).join("\n")}`
    : "";
  const guidanceText = m.guidance ? `\n### 指导\n${m.guidance}` : "";

  return `## 编排知识指导：${m.topic}${sourceLabel}
来源：${m.source}（置信度 ${(m.confidence * 100).toFixed(0)}%）${guidanceText}${phasesText}

请遵循上述方法论的阶段顺序执行分析，不要跳过必取证项。${
    m.granularity === "minimal" ? "（最小骨架方法论，LLM 需自主补充细节）" : ""
  }`;
}

/** 收尾意图检测：上一步是否调了 finalize 或没调任何工具（想自然停止）。 */
function isFinalizeAttempt(steps: PrepareStepContext["steps"]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  // 没调任何工具的步骤（finishReason=stop）= 想自然收尾
  if (last.toolCalls.length === 0) return true;
  // 调了 nexus_finalize（key 形态 nexus.finalize 也匹配）
  return last.toolCalls.some(
    (tc) => tc.toolName === "nexus_finalize" || tc.toolName === "nexus.finalize",
  );
}

/** 触发证据评估（仅收尾意图时），返回评估结论或 null（未触发/无轨迹/放行）。 */
async function tryEvaluateEvidenceGate(
  ctx: PrepareStepContext,
  model: LanguageModel,
  compatMode?: boolean,
): Promise<{ action: "soft_warn" | "block"; confidence: number; evidenceGaps: string[]; overClaims: string[] } | null> {
  if (!isFinalizeAttempt(ctx.steps)) return null;
  // 首步即收尾（如澄清反问）无取证轨迹，跳过评估
  const hasEvidence = ctx.steps.some((s) => s.toolCalls.length > 0);
  if (!hasEvidence) return null;

  const verdict = await evaluateEvidenceGate(ctx.steps, ctx.intent, {
    model,
    compatMode,
  });
  if (verdict.action === "pass") return null; // 放行不干预
  return {
    action: verdict.action,
    confidence: verdict.confidence,
    evidenceGaps: verdict.evidenceGaps,
    overClaims: verdict.overClaims,
  };
}

/** 把评估结论应用到 prepareStep 结果（软提示或硬阻断）。 */
function applyGateVerdict(
  verdict: { action: "soft_warn" | "block"; confidence: number; evidenceGaps: string[]; overClaims: string[] },
  result: PrepareStepResult,
  allToolNames: string[],
): void {
  const gapsText = verdict.evidenceGaps.length > 0
    ? `\n证据缺口：\n${verdict.evidenceGaps.map((g) => `- ${g}`).join("\n")}`
    : "";
  const claimsText = verdict.overClaims.length > 0
    ? `\n可能的过度声明：\n${verdict.overClaims.map((c) => `- ${c}`).join("\n")}`
    : "";

  if (verdict.action === "block") {
    // 硬阻断：从 activeTools 移除 nexus_finalize，模型这一步看不到收尾工具
    result.activeTools = (result.activeTools ?? allToolNames).filter((n) => n !== "nexus_finalize");
    result.system = `## 证据不足，禁止收尾（评估 confidence=${verdict.confidence.toFixed(2)}）${gapsText}${claimsText}\n\n请继续取证补齐上述缺口后再收尾。可参考系统提示中的"证据源地图"选择合适的取证工具。`;
  } else {
    // soft_warn：保留 finalize 但注入警告，主模型自己决定
    const warnText = `## 证据充分性提醒（confidence=${verdict.confidence.toFixed(2)}）${gapsText}${claimsText}\n\n若证据已足够支撑结论可收尾，否则建议先补取证（可参考系统提示中的"证据源地图"）。`;
    result.system = result.system ? `${result.system}\n\n${warnText}` : warnText;
  }
}
