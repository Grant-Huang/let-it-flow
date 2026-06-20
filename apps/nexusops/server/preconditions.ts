/**
 * NexusOps 业务前置条件（V 层内容 —— 应用声明，平台 PreconditionRegistry 执行）。
 *
 * 来自设计："某类任务在哪些信息被确认之前禁止进入回答阶段——比靠模型自我感知可靠得多"。
 *
 * 两类触发时机：
 *   - on_finalize：finalize 时检查（缺省）。证据不足则 finishReason=precondition_unmet。
 *   - every_step：每步检查（由 prepareStep 钩子注入提示，见 prepare-step.ts）。
 *                 让"取证不足别急着答"实时生效，而非拖到 finalize。
 *
 * 两个域各注册 on_finalize + every_step 版本，复用同一个 checkEvidenceGate helper，
 * 避免逻辑重复。every_step 版返回的 prompt 由 prepareStep 注入 system 提示。
 */
import { PreconditionRegistry, calledToolNames } from "../../../src/agent/precondition.js";
import type { Precondition, StepTrace } from "../../../src/agent/types.js";

/** 业务域取证要求定义。 */
interface EvidenceGateSpec {
  /** 规则 id 后缀（on_finalize / every_step 各一份）。 */
  id: string;
  /** 域名（OEE / 停机）。 */
  domain: string;
  /** 该域相关的意图关键词（扫 thought 粗判意图）。 */
  keywords: string[];
  /** 满足取证的工具名前缀或全名判定。 */
  hasEvidence: (called: Set<string>) => boolean;
  /** 缺证时建议调的工具名。 */
  missingTool: string;
  /** 缺证时喂给 LLM 的提示文案。 */
  prompt: string;
}

/** OEE 域取证要求。 */
const OEE_GATE: EvidenceGateSpec = {
  id: "oee_evidence",
  domain: "OEE",
  keywords: ["oee", "可用性", "表现性", "设备综合效率"],
  hasEvidence: (called) => [...called].some((n) => n.startsWith("oee.")),
  missingTool: "oee.realtime",
  prompt:
    "讨论涉及 OEE，但尚未拿到 oee.* 实测数据。请先调 oee.realtime 或 oee.history 取证，再给结论。",
};

/** 停机/设备域取证要求。 */
const DOWNTIME_GATE: EvidenceGateSpec = {
  id: "downtime_evidence",
  domain: "停机",
  keywords: ["停机", "宕机", "故障", "downtime", "mtbf", "mttr"],
  hasEvidence: (called) =>
    [...called].some((n) => n.startsWith("equipment.")) ||
    called.has("skill.downtime_root_cause"),
  missingTool: "equipment.downtime",
  prompt:
    "讨论涉及停机/设备故障，但尚未取证。请先调 equipment.downtime（或 skill.downtime_root_cause 沉淀流程）补齐证据。",
};

const ALL_GATES: EvidenceGateSpec[] = [OEE_GATE, DOWNTIME_GATE];

/**
 * 证据门检查：trace 里已出现收尾/建议工具（nexus_advise/nexus_finalize），
 * 且意图涉及该域，但未取证 → 未满足。
 *
 * on_finalize 与 every_step 共用同一检查逻辑，区别仅在触发时机与 harness 处理方式。
 */
function checkEvidenceGate(
  trace: StepTrace[],
  gate: EvidenceGateSpec,
): { met: true } | { met: false; missingTool: string; prompt: string } {
  const called = calledToolNames(trace);
  const hasAdvise = called.has("nexus_advise") || called.has("nexus_finalize");
  const mentionsDomain = mentions(trace, gate.keywords);
  if (hasAdvise && mentionsDomain && !gate.hasEvidence(called)) {
    return { met: false, missingTool: gate.missingTool, prompt: gate.prompt };
  }
  return { met: true };
}

/**
 * 扫描所有 every_step 型证据门，返回未满足的提示列表。
 * prepare-step.ts 调此函数，把提示注入 system 提示，让 LLM 在下一步补取证。
 */
export function collectEveryStepReminders(trace: StepTrace[]): string[] {
  const reminders: string[] = [];
  for (const gate of ALL_GATES) {
    const r = checkEvidenceGate(trace, gate);
    if (!r.met) reminders.push(r.prompt);
  }
  return reminders;
}

/**
 * 构造 NexusOps 的业务前置条件注册表。
 *
 * 注册的规则：
 *   - on_finalize 型：finalize 时检查（已有，保留向后兼容）
 *   - every_step 型：每步检查（新增，提示由 prepareStep 注入）
 */
export function buildNexusPreconditions(): PreconditionRegistry {
  const reg = new PreconditionRegistry();

  for (const gate of ALL_GATES) {
    // on_finalize 版（缺省）：finalize 时兜底检查
    reg.register({
      id: `require_${gate.id}`,
      description: `给出 ${gate.domain} 相关结论前，必须先取证（on_finalize 兜底）`,
      phase: "on_finalize",
      check: (trace) => checkEvidenceGate(trace, gate),
    } satisfies Precondition);

    // every_step 版：每步检查，提前拦截"未取证就想给建议"
    reg.register({
      id: `require_${gate.id}_early`,
      description: `涉及 ${gate.domain} 时，每步检查是否已取证（提示由 prepareStep 注入）`,
      phase: "every_step",
      check: (trace) => checkEvidenceGate(trace, gate),
    } satisfies Precondition);
  }

  return reg;
}

/** 把 preconditions 数组化（harness 直接消费）。 */
export function nexusPreconditionList(reg: PreconditionRegistry): Precondition[] {
  return reg.list();
}

/** 扫描 stepTrace 的 thought 文本是否提及任意关键词（粗判意图）。 */
function mentions(trace: StepTrace[], keywords: string[]): boolean {
  for (const step of trace) {
    const t = (step.thought ?? "").toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) return true;
  }
  return false;
}
