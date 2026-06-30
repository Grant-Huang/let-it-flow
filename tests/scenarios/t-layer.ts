/**
 * T 层场景：工具协议与证据信封。
 *
 * 假设：工具产出的证据信封元数据（freshness/confidence）应正确反映数据质量。
 * 预期：evidenceStrength 按 freshness×confidence 计算；prepareStep 据主导域裁工具。
 */
import type { Scenario } from "./types.js";
import { wrapEvidence, evidenceStrength, isEvidenceEnvelope, summarizeEvidence } from "../../src/core/evidence-envelope.js";
import { buildNexusPrepareStep } from "../../apps/nexusops/server/prepare-step.js";
import type { PrepareStepContext } from "../../src/agent/types.js";

export const scenarioT1EvidenceEnvelope: Scenario = {
  id: "T1",
  layer: "T",
  title: "证据信封：元数据完整 + 强度计算",
  hypothesis: "工具用 wrapEvidence 包装实测数据，元数据应完整且 strength 正确",
  purpose: "验证 EvidenceEnvelope 结构完整、强度公式（freshness×confidence）、isEvidenceEnvelope 校验、summarize 文本",
  procedure: [
    "wrapEvidence 构造 measured+realtime 证据",
    "断言 isEvidenceEnvelope=true, strength=1.0",
    "构造 inferred+historical 弱证据，断言 strength=0.16",
    "summarizeEvidence 产出可读徽章",
  ],
  calls: [
    { target: "wrapEvidence / evidenceStrength / isEvidenceEnvelope / summarizeEvidence", kind: "real", note: "真实证据信封 helper（生产代码路径）" },
    { target: "数据负载", kind: "synthetic", note: "手搓的 {oee:0.65} 数据，非真实 MES 取数" },
  ],
  assertions: [
    {
      name: "强证据 strength=1.0",
      expected: "measured+realtime → strength=1.0, isEvidenceEnvelope=true",
    },
    {
      name: "弱证据 strength=0.16",
      expected: "inferred(0.4)×historical(0.4)=0.16",
    },
    {
      name: "summarize 含系统/时效/置信度徽章",
      expected: "summarizeEvidence 输出含 [MES realtime ... conf=measured]",
    },
  ],
  async run() {
    const strong = wrapEvidence({ oee: 0.65 }, {
      freshness: "realtime", confidence: "measured", system: "MES", provenance: "/api/oee/L01",
    });
    const s1 = evidenceStrength(strong);
    this.assertions[0]!.actual = `strength=${s1}, isEnvelope=${isEvidenceEnvelope(strong)}`;
    this.assertions[0]!.passed = s1 === 1.0 && isEvidenceEnvelope(strong);

    const weak = wrapEvidence({ oee: 0.3 }, {
      freshness: "historical", confidence: "inferred", system: "old", provenance: "legacy",
    });
    const s2 = evidenceStrength(weak);
    this.assertions[1]!.actual = `strength=${s2.toFixed(2)}`;
    this.assertions[1]!.passed = Math.abs(s2 - 0.16) < 0.001;

    const summary = summarizeEvidence(strong);
    const hasBadge = summary.includes("MES") && summary.includes("realtime") && summary.includes("measured");
    this.assertions[2]!.actual = `徽章：${summary}`;
    this.assertions[2]!.passed = hasBadge;
  },
};

export const scenarioT2PrepareStepPrune: Scenario = {
  id: "T2",
  layer: "T",
  title: "prepareStep 动态裁工具：识别主导域后收窄",
  hypothesis: "trace 里 oee.* 工具调用占主导（>50%）",
  purpose: "验证 prepareStep 识别主导域=oee 后，activeTools 只保留 oee.* + core + nexus + skill，裁掉其他 domain",
  procedure: [
    "构造 oee 调用 3 次、quality 调用 1 次的 trace（oee 占 75%）",
    "调用 buildNexusPrepareStep(allNames)(ctx)",
    "断言 activeTools 含 oee.* 但不含 quality.*（除非 core/nexus/skill）",
  ],
  calls: [
    { target: "buildNexusPrepareStep / detectDominantDomain", kind: "real", note: "真实主导域检测 + 工具裁剪逻辑" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的 oee 主导轨迹" },
    { target: "allToolNames", kind: "synthetic", note: "构造的工具名清单" },
  ],
  assertions: [
    {
      name: "主导域 oee → 保留 oee 裁 quality",
      expected: "activeTools 含 oee.realtime，不含 quality.pareto",
    },
    {
      name: "core/nexus/skill 始终保留",
      expected: "activeTools 含 core.web_search, nexus_finalize, skill.oee_diagnose",
    },
  ],
  async run() {
    const allNames = [
      "oee.realtime", "oee.decompose", "oee.quality_loss",
      "quality.pareto", "quality.defects",
      "equipment.downtime",
      "core.web_search", "core.knowledge_base",
      "nexus_finalize", "nexus_advise",
      "skill.oee_diagnose",
    ];
    const prepareStep = buildNexusPrepareStep(allNames);
    const ctx: PrepareStepContext = {
      steps: [{
        stepNumber: 0,
        thought: "诊断 OEE",
        toolCalls: [
          { id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 },
          { id: "tc2", toolName: "oee.decompose", args: {}, result: {}, durationMs: 0 },
          { id: "tc3", toolName: "oee.quality_loss", args: {}, result: {}, durationMs: 0 },
          { id: "tc4", toolName: "quality.pareto", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      }],
    } as never;
    const result = await prepareStep(ctx);
    const active = result?.activeTools ?? [];
    const hasOee = active.includes("oee.realtime");
    const noQuality = !active.includes("quality.pareto");
    this.assertions[0]!.actual = `activeTools ${active.length} 个，含 oee=${hasOee}, 含 quality=${!noQuality}`;
    this.assertions[0]!.passed = hasOee && noQuality;

    const keepCore = active.includes("core.web_search");
    const keepNexus = active.includes("nexus_finalize");
    const keepSkill = active.includes("skill.oee_diagnose");
    this.assertions[1]!.actual = `core=${keepCore}, nexus=${keepNexus}, skill=${keepSkill}`;
    this.assertions[1]!.passed = keepCore && keepNexus && keepSkill;
  },
};

export const scenarioT3PrepareStepReminder: Scenario = {
  id: "T3",
  layer: "T",
  title: "prepareStep 取证不足 → 注入 system 提醒",
  hypothesis: "trace 表现出给结论倾向但取证不足",
  purpose: "验证 prepareStep 在检测到 every_step 缺失时，向 result.system 注入提醒文本",
  procedure: [
    "构造只含 nexus_advise（未取证）的 trace",
    "调用 prepareStep(ctx)",
    "断言 result.system 非空且含'前置条件提醒'",
  ],
  calls: [
    { target: "buildNexusPrepareStep / collectEveryStepReminders", kind: "real", note: "真实提醒注入逻辑" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的未取证轨迹" },
  ],
  assertions: [
    {
      name: "注入 system 提醒",
      expected: "result.system 非空，含'前置条件提醒'",
    },
  ],
  async run() {
    const prepareStep = buildNexusPrepareStep(["nexus_advise", "oee.realtime"]);
    const ctx: PrepareStepContext = {
      steps: [{
        stepNumber: 0,
        thought: "OEE 低，直接建议",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      }],
    } as never;
    const result = await prepareStep(ctx);
    const hasReminder = Boolean(result?.system && result.system.includes("前置条件提醒"));
    this.assertions[0]!.actual = `system 注入=${hasReminder}，长度=${result?.system?.length ?? 0}`;
    this.assertions[0]!.passed = hasReminder;
  },
};

export const tLayerScenarios: Scenario[] = [scenarioT1EvidenceEnvelope, scenarioT2PrepareStepPrune, scenarioT3PrepareStepReminder];
