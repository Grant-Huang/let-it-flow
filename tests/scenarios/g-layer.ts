/**
 * G 层场景：治理（Governance）—— 可信度保障。
 *
 * 假设 1：agent 试图调用 destructive 工具（强制停线）。
 * 预期：preToolUse 治理链阻断（默认禁止 destructive）。
 *
 * 假设 2：agent 反复引用 inferred 证据下结论。
 * 预期：postToolUse 链在第 2 次引用时注入 warn（要求交叉验证）。
 *
 * 假设 3：批量改排产超阈值。
 * 预期：preToolUse 治理链阻断（>3 工单）。
 */
import type { Scenario } from "./types.js";
import { buildNexusGovernance } from "../../apps/nexusops/server/governance.js";
import { buildNexusPostToolUseChain } from "../../apps/nexusops/server/post-rules.js";
import type { EvidenceEnvelope } from "../../src/core/evidence-envelope.js";

function makeInferredEvidence(provenance: string): EvidenceEnvelope {
  return {
    data: { value: 0.6 },
    freshness: "realtime",
    capturedAt: "2026-06-20T00:00:00Z",
    confidence: "inferred",
    source: { system: "llm", provenance },
  };
}

function makeMeasuredEvidence(): EvidenceEnvelope {
  return {
    data: { value: 0.65 },
    freshness: "realtime",
    capturedAt: "2026-06-20T00:00:00Z",
    confidence: "measured",
    source: { system: "MES", provenance: "/api/oee/L01" },
  };
}

export const scenarioG1DestructiveBlock: Scenario = {
  id: "G1",
  layer: "G",
  title: "destructive 工具默认阻断（强制停线需显式授权）",
  hypothesis: "agent 调用 mcp.mes.force_stop_line（risk=destructive），且未设置 NEXUS_ALLOW_DESTRUCTIVE",
  purpose: "验证 preToolUse 治理链按 risk=destructive 阻断，返回 block_destructive_by_default",
  procedure: [
    "清除 NEXUS_ALLOW_DESTRUCTIVE 环境变量",
    "调用 buildNexusGovernance().preToolUse('mcp.mes.force_stop_line', {}, 'destructive')",
    "断言返回 allow=false 且 ruleId=block_destructive_by_default",
  ],
  calls: [
    { target: "buildNexusGovernance / preToolUse", kind: "real", note: "真实治理规则链判定" },
    { target: "mcp.mes.force_stop_line", kind: "mock", note: "工具名 + risk 参数是构造的，未真实执行（被治理层阻断在执行前）" },
    { target: "NEXUS_ALLOW_DESTRUCTIVE", kind: "real", note: "真实读取环境变量开关" },
  ],
  assertions: [
    {
      name: "destructive 默认阻断",
      expected: "allow=false, ruleId=block_destructive_by_default",
    },
    {
      name: "NEXUS_ALLOW_DESTRUCTIVE=1 放行",
      expected: "设置开关后 allow=true（HITL 仍兜底）",
    },
    {
      name: "safe 工具不受影响",
      expected: "oee.realtime (risk=safe) 始终 allow=true",
    },
  ],
  async run() {
    delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    const chain = buildNexusGovernance();

    const r1 = chain.preToolUse("mcp.mes.force_stop_line", {}, "destructive");
    this.assertions[0]!.actual = `allow=${r1.allow}, ruleId=${!r1.allow ? r1.ruleId : "n/a"}`;
    this.assertions[0]!.passed = r1.allow === false && !r1.allow && r1.ruleId === "block_destructive_by_default";

    process.env.NEXUS_ALLOW_DESTRUCTIVE = "1";
    try {
      const chain2 = buildNexusGovernance();
      const r2 = chain2.preToolUse("mcp.mes.force_stop_line", {}, "destructive");
      this.assertions[1]!.actual = `allow=${r2.allow}`;
      this.assertions[1]!.passed = r2.allow === true;
    } finally {
      delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    }

    const chain3 = buildNexusGovernance();
    const r3 = chain3.preToolUse("oee.realtime", {}, "safe");
    this.assertions[2]!.actual = `allow=${r3.allow}`;
    this.assertions[2]!.passed = r3.allow === true;
  },
};

export const scenarioG2BulkScheduleBlock: Scenario = {
  id: "G2",
  layer: "G",
  title: "批量改排产超阈值阻断（>3 工单）",
  hypothesis: "agent 试图一次性重新分配 5 个工单的产能（items.length=5 > 3）",
  purpose: "验证 guard_bulk_schedule_change 规则按工单数阻断，避免 agent 一次大改排产",
  procedure: [
    "调用 preToolUse('mcp.mes.reallocate_capacity', { items: [1,2,3,4,5] }, 'write')",
    "断言返回 allow=false",
    "对照：items.length=3 应放行",
  ],
  calls: [
    { target: "buildNexusGovernance / preToolUse", kind: "real", note: "真实 guard_bulk_schedule_change 规则" },
    { target: "mcp.mes.reallocate_capacity", kind: "mock", note: "工具调用是构造的，治理层在执行前判定" },
  ],
  assertions: [
    {
      name: ">3 工单阻断",
      expected: "5 个工单 → allow=false",
    },
    {
      name: "≤3 工单放行",
      expected: "3 个工单 → allow=true（走 HITL 而非 governance）",
    },
  ],
  async run() {
    delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    const chain = buildNexusGovernance();

    const r1 = chain.preToolUse("mcp.mes.reallocate_capacity", { items: [1, 2, 3, 4, 5] }, "write");
    this.assertions[0]!.actual = `5 工单 → allow=${r1.allow}`;
    this.assertions[0]!.passed = r1.allow === false;

    const r2 = chain.preToolUse("mcp.mes.reallocate_capacity", { items: [1, 2, 3] }, "write");
    this.assertions[1]!.actual = `3 工单 → allow=${r2.allow}`;
    this.assertions[1]!.passed = r2.allow === true;
  },
};

export const scenarioG3InferredRepeat: Scenario = {
  id: "G3",
  layer: "G",
  title: "inferred 证据反复引用 → postToolUse 注入交叉验证 warn",
  hypothesis: "agent 连续 2 次使用同一来源的 inferred 证据下结论，未交叉验证",
  purpose: "验证 postToolUse 链的会话级计数器：第 2 次引用 inferred 证据时注入 warn（不阻断，提示降权）",
  procedure: [
    "新建一条 PostToolUseChain（每 run 一条，含会话状态）",
    "第 1 次喂 inferred 证据 → 应无 warn（未达 2 次阈值）",
    "第 2 次喂同源 inferred 证据 → 应产生含'交叉验证'的 warn",
    "对照：measured 证据反复用 → 无 inferred warn",
  ],
  calls: [
    { target: "buildNexusPostToolUseChain / postToolUse", kind: "real", note: "真实 postToolUse 规则链 + 会话级计数器" },
    { target: "EvidenceEnvelope 输入", kind: "synthetic", note: "手搓的 inferred/measured 证据对象，非真实工具产出" },
  ],
  assertions: [
    {
      name: "inferred 首次：无 inferred-repeats warn",
      expected: "第 1 次 warns 不含'交叉验证'（仅可能含低强度 warn）",
    },
    {
      name: "inferred 第 2 次：触发交叉验证 warn",
      expected: "第 2 次 warns 含'交叉验证'",
    },
    {
      name: "measured 反复用：不触发 inferred warn",
      expected: "measured 证据反复引用不产生 inferred 相关 warn",
    },
  ],
  async run() {
    const chain = buildNexusPostToolUseChain();
    const inf = makeInferredEvidence("llm-guess-1");

    const r1 = chain.postToolUse("oee.realtime", {}, inf);
    const inferredWarn1 = r1.warns.some((w) => w.reason.includes("交叉验证"));
    this.assertions[0]!.actual = `第 1 次 warns=${r1.warns.length} 条，含交叉验证=${inferredWarn1}`;
    this.assertions[0]!.passed = !inferredWarn1;

    const r2 = chain.postToolUse("oee.realtime", {}, inf);
    const inferredWarn2 = r2.warns.some((w) => w.reason.includes("交叉验证"));
    this.assertions[1]!.actual = `第 2 次 warns=${r2.warns.length} 条，含交叉验证=${inferredWarn2}`;
    this.assertions[1]!.passed = inferredWarn2;

    // 新 chain 验证 measured 不触发
    const chain2 = buildNexusPostToolUseChain();
    const meas = makeMeasuredEvidence();
    chain2.postToolUse("oee.realtime", {}, meas);
    const rMeas = chain2.postToolUse("oee.realtime", {}, meas);
    const measInferredWarn = rMeas.warns.some((w) => w.reason.includes("交叉验证"));
    this.assertions[2]!.actual = `measured 第 2 次 warns=${rMeas.warns.length} 条，含交叉验证=${measInferredWarn}`;
    this.assertions[2]!.passed = !measInferredWarn;
  },
};

export const scenarioG4LowEvidenceStrength: Scenario = {
  id: "G4",
  layer: "G",
  title: "低强度证据（historical+inferred）→ postToolUse warn",
  hypothesis: "工具返回一条 freshness=historical、confidence=inferred 的弱证据（strength=0.16）",
  purpose: "验证 warn_low_evidence_strength 规则在 strength<0.5 时注入 warn，提醒 LLM 降权",
  procedure: [
    "构造 strength=0.4×0.4=0.16 的证据",
    "调用 postToolUse → 断言 warns 含'强度'",
    "对照：measured+realtime（strength=1.0）无 warn",
  ],
  calls: [
    { target: "buildNexusPostToolUseChain / evidenceStrength", kind: "real", note: "真实证据强度计算 + 低强度规则" },
    { target: "EvidenceEnvelope 输入", kind: "synthetic", note: "手搓的 historical+inferred 弱证据" },
  ],
  assertions: [
    {
      name: "低强度证据触发 warn",
      expected: "warns 含'强度'字样",
    },
    {
      name: "强证据无 warn",
      expected: "measured+realtime（strength=1.0）warns 为空",
    },
  ],
  async run() {
    const chain = buildNexusPostToolUseChain();
    const weak: EvidenceEnvelope = {
      data: {}, freshness: "historical", capturedAt: "2020-01-01T00:00:00Z",
      confidence: "inferred", source: { system: "old", provenance: "x" },
    };
    const r1 = chain.postToolUse("oee.history", {}, weak);
    const weakWarn = r1.warns.some((w) => w.reason.includes("强度"));
    this.assertions[0]!.actual = `warns=${r1.warns.length} 条，含强度=${weakWarn}`;
    this.assertions[0]!.passed = weakWarn;

    const chain2 = buildNexusPostToolUseChain();
    const strong = makeMeasuredEvidence();
    const r2 = chain2.postToolUse("oee.realtime", {}, strong);
    this.assertions[1]!.actual = `warns=${r2.warns.length} 条`;
    this.assertions[1]!.passed = r2.warns.length === 0;
  },
};

export const gLayerScenarios: Scenario[] = [
  scenarioG1DestructiveBlock,
  scenarioG2BulkScheduleBlock,
  scenarioG3InferredRepeat,
  scenarioG4LowEvidenceStrength,
];
