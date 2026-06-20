/**
 * C 层场景：准确度保障 —— 输出结构自检。
 *
 * 假设 1：agent 产出的建议缺字段 / 数值越界。
 * 预期：validateAdvise 检测到并返回 invalid=true，工具回退让 LLM 修正。
 *
 * 假设 2：建议合规但缺证据引用。
 * 预期：validateAdvise 返回 valid=true 但带 evidenceRefWarnings。
 */
import type { Scenario } from "./types.js";
import { validateAdvise } from "../../apps/nexusops/tools/advise-validator.js";

export const scenarioC1AdviseMissingFields: Scenario = {
  id: "C1",
  layer: "C",
  title: "nexus_advise 输出缺字段/越界 → 结构自检拦截",
  hypothesis: "agent 产出的建议缺少 rationale，且 impact=1.5（越界）",
  purpose: "验证 validateAdvise 检测到字段缺失和数值越界，返回 invalid=true + reasons，迫使 LLM 修正",
  procedure: [
    "构造一条缺 rationale、impact=1.5 的建议",
    "调用 validateAdvise([建议])",
    "断言 valid=false 且 reasons 含 rationale 缺失 + impact 越界",
  ],
  calls: [
    { target: "validateAdvise", kind: "real", note: "真实输出结构校验器（字段完整性 + 数值范围）" },
    { target: "建议输入", kind: "synthetic", note: "手搓的违规建议对象" },
  ],
  assertions: [
    {
      name: "缺字段 + 越界 → invalid",
      expected: "valid=false, reasons 含 rationale 缺失 和 impact 越界",
    },
  ],
  async run() {
    const v = validateAdvise([
      { title: "换轴承", rationale: "", impact: 1.5, executionScore: 0.7, confidence: 0.8 },
    ]);
    const missingRationale = v.reasons.some((r) => r.includes("rationale"));
    const impactRange = v.reasons.some((r) => r.includes("impact"));
    this.assertions[0]!.actual = `valid=${v.valid}, reasons=${v.reasons.length} 条（缺 rationale=${missingRationale}, impact 越界=${impactRange}）`;
    this.assertions[0]!.passed = v.valid === false && missingRationale && impactRange;
  },
};

export const scenarioC2AdviseValidButNoRefs: Scenario = {
  id: "C2",
  layer: "C",
  title: "建议合规但缺证据引用 → warn 提示补引用",
  hypothesis: "agent 产出的建议字段齐全、数值合规，但没填 evidenceRefs",
  purpose: "验证 validateAdvise 返回 valid=true（不阻断），但 evidenceRefWarnings 提示补引用",
  procedure: [
    "构造一条合规但无 evidenceRefs 的建议",
    "调用 validateAdvise([建议])",
    "断言 valid=true 且 evidenceRefWarnings 非空",
  ],
  calls: [
    { target: "validateAdvise", kind: "real", note: "真实输出结构校验器" },
    { target: "建议输入", kind: "synthetic", note: "手搓的合规无引用建议" },
  ],
  assertions: [
    {
      name: "合规但无引用 → valid + warn",
      expected: "valid=true, evidenceRefWarnings 非空",
    },
  ],
  async run() {
    const v = validateAdvise([
      { title: "换轴承", rationale: "降低故障率", impact: 0.8, executionScore: 0.7, confidence: 0.8 },
    ]);
    this.assertions[0]!.actual = `valid=${v.valid}, evidenceRefWarnings=${v.evidenceRefWarnings.length} 条`;
    this.assertions[0]!.passed = v.valid === true && v.evidenceRefWarnings.length > 0;
  },
};

export const scenarioC3AdviseFullyValid: Scenario = {
  id: "C3",
  layer: "C",
  title: "完整合规建议（含证据引用）→ 无 warn",
  hypothesis: "agent 产出字段齐全、数值合规、带 evidenceRefs 的建议",
  purpose: "验证 validateAdvise 返回 valid=true 且 evidenceRefWarnings 为空（绿灯放行）",
  procedure: [
    "构造一条完整合规带引用的建议",
    "调用 validateAdvise([建议])",
    "断言 valid=true 且 evidenceRefWarnings 为空",
  ],
  calls: [
    { target: "validateAdvise", kind: "real", note: "真实输出结构校验器" },
    { target: "建议输入", kind: "synthetic", note: "手搓的完整合规建议" },
  ],
  assertions: [
    {
      name: "完整合规 → 绿灯",
      expected: "valid=true, evidenceRefWarnings 为空, reasons 为空",
    },
  ],
  async run() {
    const v = validateAdvise([
      { title: "换轴承", rationale: "降低故障率", impact: 0.8, executionScore: 0.7, confidence: 0.8, evidenceRefs: ["oee.realtime", "equipment.downtime"] },
    ]);
    this.assertions[0]!.actual = `valid=${v.valid}, reasons=${v.reasons.length}, evidenceRefWarnings=${v.evidenceRefWarnings.length}`;
    this.assertions[0]!.passed = v.valid === true && v.evidenceRefWarnings.length === 0 && v.reasons.length === 0;
  },
};

export const cLayerScenarios: Scenario[] = [scenarioC1AdviseMissingFields, scenarioC2AdviseValidButNoRefs, scenarioC3AdviseFullyValid];
