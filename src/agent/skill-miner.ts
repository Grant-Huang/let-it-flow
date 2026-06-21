/**
 * skill 候选挖矿（L 层机制 —— 从 StepTrace 提取可复用模式）。
 *
 * 设计见计划工作流 D2：
 *   - 把每条 trace 压成工具名序列，做 4-gram 聚类
 *   - 三硬信号 AND：簇内 ≥3 次 + 成本占比 >60% + 成功率 ≥80%
 *   - 反信号一票否决：含 inferred 硬结论 / HITL 决策 / governance 阻断 / _skill.errors
 *
 * 输出候选列表（不直接造 skill），由 skill-confirm.ts 转成 draft DynamicStepsFn。
 *
 * 不做分类器：宁可多召回（多提示几次），用 SkillRegistry 跨会话去重消化噪音。
 */
import type { StepTrace } from "./types.js";
import { isEvidenceEnvelope } from "../core/evidence-envelope.js";

/** n-gram 长度（工具序列片段）。 */
const NGRAM_SIZE = 4;
/** 簇内最小出现次数（重复度阈值）。 */
const MIN_OCCURRENCES = 3;
/** 子序列成本占总成本的最小占比。 */
const MIN_COST_RATIO = 0.6;
/** 子序列成功率下限。 */
const MIN_SUCCESS_RATIO = 0.8;

/** 一条 trace 的压缩视图（工具名序列 + 元数据）。 */
interface TraceDigest {
  /** 工具名序列（含重复，按调用顺序）。 */
  sequence: string[];
  /** 本条 trace 的总 token（用于成本占比计算）。 */
  totalTokens: number;
  /** 本条 trace 是否成功（finishReason 非 error/precondition_unmet）。 */
  success: boolean;
  /** 本条 trace 是否命中反信号。 */
  hasAntiSignal: boolean;
}

/** 候选 skill 模式。 */
export interface SkillCandidate {
  /** 签名（n-gram 工具名用 → 连接，用于去重）。 */
  signature: string;
  /** 出现次数。 */
  occurrences: number;
  /** 命中的硬信号详情。 */
  signals: {
    repeatMet: boolean;
    costMet: boolean;
    successMet: boolean;
    costRatio: number;
    successRatio: number;
  };
  /** 是否被反信号否决。 */
  vetoed: boolean;
  /** 否决理由（vetoed=true 时）。 */
  vetoReason?: string;
  /** 样本 trace（首个命中且无反信号的，供 skill-confirm 提取步骤）。 */
  sampleTrace?: StepTrace[];
}

/**
 * 从一批 trace 挖出 skill 候选。
 *
 * @param runs  多条完整 ReAct 轨迹（每条是一次 run 的 stepTrace[]）
 * @returns     候选列表（已按 occurrences 降序）
 */
export function mineSkillCandidates(runs: StepTrace[][]): SkillCandidate[] {
  // 1. 每条 trace 压成 digest
  const digests = runs.map(digestTrace).filter((d) => d.sequence.length >= NGRAM_SIZE);

  // 2. 抽取所有 n-gram，按签名聚类
  const clusters = new Map<string, { digest: TraceDigest; tokens: number; success: boolean; antiSignal: boolean; trace: StepTrace[] }[]>();
  for (let i = 0; i < digests.length; i++) {
    const d = digests[i]!;
    const ngrams = extractNgrams(d.sequence, NGRAM_SIZE);
    for (const ng of ngrams) {
      const sig = ng.join("→");
      if (!clusters.has(sig)) clusters.set(sig, []);
      clusters.get(sig)!.push({ digest: d, tokens: ng.length, success: d.success, antiSignal: d.hasAntiSignal, trace: runs[i]! });
    }
  }

  // 3. 对每个簇评估三硬信号 + 反信号
  const candidates: SkillCandidate[] = [];
  for (const [signature, members] of clusters) {
    const occurrences = members.length;
    const repeatMet = occurrences >= MIN_OCCURRENCES;
    if (!repeatMet) continue; // 重复度不够，跳过（最常见的早期过滤）

    // 成本占比：该 n-gram 在各 trace 中 token / 该 trace 总 token 的平均占比
    // n-gram token 用其长度近似（工具调用数 ≈ 步骤成本）
    const costRatios = members.map((m) => m.digest.sequence.length > 0 ? NGRAM_SIZE / m.digest.sequence.length : 0);
    const avgCostRatio = costRatios.reduce((a, b) => a + b, 0) / costRatios.length;
    const costMet = avgCostRatio >= MIN_COST_RATIO;

    // 成功率：该 n-gram 出现的 trace 中成功的占比
    const successCount = members.filter((m) => m.success).length;
    const successRatio = successCount / occurrences;
    const successMet = successRatio >= MIN_SUCCESS_RATIO;

    // 反信号：任一成员命中即否决
    const vetoedMember = members.find((m) => m.antiSignal);
    const vetoed = Boolean(vetoedMember);
    const vetoReason = vetoedMember ? "含 inferred 硬结论 / HITL 决策 / governance 阻断 / skill 部分失败" : undefined;

    candidates.push({
      signature,
      occurrences,
      signals: {
        repeatMet,
        costMet,
        successMet,
        costRatio: avgCostRatio,
        successRatio,
      },
      vetoed,
      vetoReason,
      sampleTrace: vetoed ? undefined : members.find((m) => !m.antiSignal)?.trace,
    });
  }

  // 4. 按 occurrences 降序
  candidates.sort((a, b) => b.occurrences - a.occurrences);
  return candidates;
}

/**
 * 只返回"值得提示用户"的候选：三硬信号全满足 + 未被反信号否决。
 * 供 SkillRegistry 跨会话去重后提示。
 */
export function promotableCandidates(runs: StepTrace[][]): SkillCandidate[] {
  return mineSkillCandidates(runs).filter(
    (c) => c.signals.repeatMet && c.signals.costMet && c.signals.successMet && !c.vetoed,
  );
}

/**
 * 把一条 trace 压成 digest：工具名序列 + 成本 + 成功 + 反信号。
 */
function digestTrace(trace: StepTrace[]): TraceDigest {
  const sequence: string[] = [];
  let totalTokens = 0;
  let hasAntiSignal = false;

  for (const step of trace) {
    if (step.usage?.totalTokens) totalTokens += step.usage.totalTokens;
    for (const tc of step.toolCalls) {
      // HITL 拒绝 = 反信号，但工具调用本身仍是模式的一部分（纳入序列）
      if (tc.rejected) {
        hasAntiSignal = true;
      }
      sequence.push(tc.toolName);
      // 检查结果反信号
      if (hasResultAntiSignal(tc.result)) hasAntiSignal = true;
    }
  }

  const lastStep = trace[trace.length - 1];
  const finishReason = lastStep?.finishReason ?? "unknown";
  const success = finishReason !== "error" && finishReason !== "precondition_unmet";

  return { sequence, totalTokens, success, hasAntiSignal };
}

/**
 * 检测工具结果是否含反信号标记。
 *   - EvidenceEnvelope confidence=inferred 被当硬结论（无交叉验证）
 *   - governance 阻断标记（governance_blocked / blocked）
 *   - skill 部分失败（_skill.errors）
 */
function hasResultAntiSignal(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const o = result as Record<string, unknown>;
  // governance 阻断
  if (o.governance_blocked === true || o.blocked === true) return true;
  // skill 部分失败
  const skill = o._skill as { errors?: unknown[] } | undefined;
  if (skill && Array.isArray(skill.errors) && skill.errors.length > 0) return true;
  // inferred 证据被反复引用（此处只标记，是否硬结论由上下文判断；保守计为反信号）
  if (isEvidenceEnvelope(result)) {
    const env = result as { confidence?: string };
    if (env.confidence === "inferred") return true;
  }
  return false;
}

/** 从序列中抽取所有长度为 n 的连续子序列。 */
function extractNgrams(sequence: string[], n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i + n <= sequence.length; i++) {
    out.push(sequence.slice(i, i + n));
  }
  return out;
}
