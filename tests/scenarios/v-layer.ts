/**
 * V 层场景：前置条件（Precondition）—— 一致性保障。
 *
 * 假设：用户问 OEE 为什么低，但 agent 没取证就想直接给结论。
 * 预期：V 层前置条件在 finalize 前 / 每步检查时拦截，要求先取证。
 */
import type { Scenario } from "./types.js";
import { buildNexusPreconditions } from "../../apps/nexusops/server/preconditions.js";

/** 构造一条"未取证就想收尾"的 trace。 */
function traceNoEvidence(finishReason: string) {
  return [
    {
      stepNumber: 0,
      thought: "用户问 OEE 为什么低，我直接给建议",
      toolCalls: [
        { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
      ],
      finishReason,
      usage: { totalTokens: 10 },
      durationMs: 0,
    },
  ] as never;
}

/** 构造一条"已取证"的 trace。 */
function traceWithEvidence() {
  return [
    {
      stepNumber: 0,
      thought: "先查实时 OEE",
      toolCalls: [
        { id: "tc1", toolName: "oee.realtime", args: { line: "L01" }, result: {}, durationMs: 0 },
        { id: "tc2", toolName: "oee.decompose", args: { line: "L01" }, result: {}, durationMs: 0 },
      ],
      finishReason: "tool-calls",
      usage: { totalTokens: 20 },
      durationMs: 0,
    },
  ] as never;
}

/**
 * 遍历所有 on_finalize 条件，返回未满足的 missingTool 列表。
 * （checkFinalize 短路返回首个，这里要看全貌，故直接遍历 finalizeOnes。）
 */
function unmetFinalizeTools(reg: ReturnType<typeof buildNexusPreconditions>, trace: unknown[]): string[] {
  const out: string[] = [];
  for (const p of reg.finalizeOnes()) {
    const r = p.check(trace as never);
    if (!r.met) out.push(r.missingTool);
  }
  return out;
}

export const scenarioV1OeeGate: Scenario = {
  id: "V1",
  layer: "V",
  title: "OEE 诊断：未取证即收尾 → finalize 前置条件拦截",
  hypothesis: "agent 在未调用 oee.realtime / oee.decompose 的情况下就调用 nexus_advise 收尾",
  purpose: "验证 on_finalize 前置条件能检测到取证缺失，返回 missingTool=oee.realtime，阻止过早结论",
  procedure: [
    "构造一条只含 nexus_advise、thought 提及 OEE、finishReason=nexus_finalize 的 trace",
    "遍历 buildNexusPreconditions().finalizeOnes() 调各自 check",
    "断言未满足列表包含 missingTool=oee.realtime",
  ],
  calls: [
    { target: "buildNexusPreconditions / finalizeOnes / Precondition.check", kind: "real", note: "真实 NexusOps 前置条件规则引擎" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的 trace（只含 nexus_advise），非真实 ReAct 运行产物" },
  ],
  assertions: [
    {
      name: "finalize 拦截：未取证 → 返回未满足条件",
      expected: "未满足列表长度 >0，且包含 missingTool=oee.realtime",
    },
    {
      name: "已取证 → 放行",
      expected: "含 oee.realtime + oee.decompose 的 trace，OEE 条件满足（不含 oee.realtime）",
    },
  ],
  async run() {
    const reg = buildNexusPreconditions();
    // 断言 1：thought 必须提及 OEE 才会触发门
    const trace = [
      {
        stepNumber: 0,
        thought: "OEE 为什么这么低，我直接建议",
        toolCalls: [{ id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 }],
        finishReason: "nexus_finalize",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ] as never;
    const blocked = unmetFinalizeTools(reg, trace);
    const oeeBlocked = blocked.includes("oee.realtime");
    this.assertions[0]!.actual = `未满足 ${blocked.length} 条，含 oee.realtime=${oeeBlocked}`;
    this.assertions[0]!.passed = blocked.length > 0 && oeeBlocked;

    // 断言 2
    const ok = unmetFinalizeTools(reg, traceWithEvidence());
    const oeeOk = !ok.includes("oee.realtime");
    this.assertions[1]!.actual = `未满足 ${ok.length} 条，含 oee.realtime=${!oeeOk}`;
    this.assertions[1]!.passed = oeeOk;
  },
};

export const scenarioV2EveryStep: Scenario = {
  id: "V2",
  layer: "V",
  title: "every_step 前置条件：每步注入取证提醒",
  hypothesis: "agent 在中途（未 finalize）就表现出给结论的倾向",
  purpose: "验证 every_step 检查能在收尾前就检测到取证缺失，并产出可注入 system prompt 的提醒文本",
  procedure: [
    "构造一条只含 nexus_advise、未 finalize 的 trace",
    "调用 checkEveryStep(trace) 检测中途拦截",
    "调用 collectEveryStepReminders(trace) 生成提醒文本",
    "断言提醒非空且含 OEE 相关字样",
  ],
  calls: [
    { target: "checkEveryStep / collectEveryStepReminders", kind: "real", note: "真实 every_step 规则引擎" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的未收尾 trace" },
  ],
  assertions: [
    {
      name: "every_step 中途拦截：未取证 → 检测到缺失",
      expected: "checkEveryStep 返回长度 >0，含 missingTool=oee.realtime",
    },
    {
      name: "提醒文本可注入 system prompt",
      expected: "collectEveryStepReminders 返回非空数组，含 'OEE' 字样",
    },
  ],
  async run() {
    const reg = buildNexusPreconditions();
    const trace = traceNoEvidence("tool-calls");
    const mid = reg.checkEveryStep(trace);
    this.assertions[0]!.actual = `checkEveryStep 返回 ${mid.length} 条`;
    this.assertions[0]!.passed = mid.length > 0 && mid.some((r) => r.missingTool === "oee.realtime");

    const { collectEveryStepReminders } = await import("../../apps/nexusops/server/preconditions.js");
    const reminders = collectEveryStepReminders(trace);
    const hasOee = reminders.some((r) => r.includes("OEE") || r.includes("oee"));
    this.assertions[1]!.actual = `提醒 ${reminders.length} 条，含 OEE 字样=${hasOee}：${reminders.slice(0, 2).join(" | ")}`;
    this.assertions[1]!.passed = reminders.length > 0 && hasOee;
  },
};

export const scenarioV3DowntimeGate: Scenario = {
  id: "V3",
  layer: "V",
  title: "停机诊断：未取证即给停机原因 → finalize 拦截",
  hypothesis: "agent 在未调用 equipment.downtime 的情况下就给停机根因结论",
  purpose: "验证停机诊断的 on_finalize 前置条件独立于 OEE，能检测停机取证缺失",
  procedure: [
    "构造一条只含 nexus_advise、thought 含'停机'的 trace",
    "遍历 finalizeOnes() 调各自 check",
    "断言未满足列表含 missingTool=equipment.downtime",
  ],
  calls: [
    { target: "buildNexusPreconditions / finalizeOnes / Precondition.check", kind: "real", note: "真实停机诊断前置条件规则" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的停机主题 trace" },
  ],
  assertions: [
    {
      name: "停机 finalize 拦截",
      expected: "未满足列表含 missingTool=equipment.downtime",
    },
  ],
  async run() {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "停机原因是设备轴承老化导致",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "nexus_finalize",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ] as never;
    const blocked = unmetFinalizeTools(reg, trace);
    const dtBlocked = blocked.includes("equipment.downtime");
    this.assertions[0]!.actual = `未满足 ${blocked.length} 条，含 equipment.downtime=${dtBlocked}`;
    this.assertions[0]!.passed = dtBlocked;
  },
};

export const vLayerScenarios: Scenario[] = [scenarioV1OeeGate, scenarioV2EveryStep, scenarioV3DowntimeGate];
