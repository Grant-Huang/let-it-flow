/**
 * NexusOps 业务前置条件（V 层内容 —— 应用声明，平台 PreconditionRegistry 执行）。
 *
 * 来自设计："某类任务在哪些信息被确认之前禁止进入回答阶段——比靠模型自我感知可靠得多"。
 *
 * 注册的条件在 ReAct finalize 时被 harness 检查：若未满足且证据不全，finishReason
 * 降级为 precondition_unmet，前端可提示"还需补取证"。
 */
import { PreconditionRegistry, calledToolNames } from "../../../src/agent/precondition.js";
import type { Precondition, StepTrace } from "../../../src/agent/types.js";

/**
 * 构造 NexusOps 的业务前置条件注册表。
 *
 * 精益诊断场景的关键纪律：给出"建议"或"收尾"前，必须拿到一手实测证据
 * （OEE 实测 + 停机/缺陷等根因数据），否则禁止单凭模型先验下结论。
 */
export function buildNexusPreconditions(): PreconditionRegistry {
  const reg = new PreconditionRegistry();

  // 条件 1：涉及 OEE 问题时，必须先调过 oee.* 实测取证。
  reg.register({
    id: "require_oee_evidence",
    description: "给出 OEE 相关结论前，必须先调 oee.* 工具拿实测 OEE 数据",
    phase: "on_finalize",
    check: (trace) => {
      const called = calledToolNames(trace);
      const hasAdvise = called.has("nexus_advise") || called.has("nexus_finalize");
      const mentionsOee = mentions(trace, ["oee", "可用性", "表现性", "设备综合效率"]);
      const hasOeeEvidence = [...called].some((n) => n.startsWith("oee."));
      if (hasAdvise && mentionsOee && !hasOeeEvidence) {
        return {
          met: false,
          missingTool: "oee.realtime",
          prompt:
            "讨论涉及 OEE，但尚未拿到 oee.* 实测数据。请先调 oee.realtime 或 oee.history 取证，再给结论。",
        };
      }
      return { met: true };
    },
  } satisfies Precondition);

  // 条件 2：涉及停机/设备根因时，必须先调 equipment.downtime 或 skill.downtime_root_cause。
  reg.register({
    id: "require_downtime_evidence",
    description: "给停机/设备退化根因前，必须先调 equipment.downtime 或 skill.downtime_root_cause",
    phase: "on_finalize",
    check: (trace) => {
      const called = calledToolNames(trace);
      const hasAdvise = called.has("nexus_advise") || called.has("nexus_finalize");
      const mentionsDowntime = mentions(trace, ["停机", "宕机", "故障", "downtime", "mtbf", "mttr"]);
      const hasDowntimeEvidence =
        [...called].some((n) => n.startsWith("equipment.")) ||
        called.has("skill.downtime_root_cause");
      if (hasAdvise && mentionsDowntime && !hasDowntimeEvidence) {
        return {
          met: false,
          missingTool: "equipment.downtime",
          prompt:
            "讨论涉及停机/设备故障，但尚未取证。请先调 equipment.downtime（或 skill.downtime_root_cause 沉淀流程）补齐证据。",
        };
      }
      return { met: true };
    },
  } satisfies Precondition);

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
