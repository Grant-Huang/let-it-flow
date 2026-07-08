/**
 * L 层场景：skill 沉淀生命周期。
 *
 * 假设 1：同一工具序列在多条 trace 里高频出现且成功。
 * 预期：skill-miner 产出候选（三硬信号 AND）。
 *
 * 假设 2：含 inferred 硬结论的轨迹。
 * 预期：被反信号一票否决，不产候选。
 *
 * 假设 3：候选确认 → draft skill → 连续成功转正。
 * 预期：SkillRegistry 计数升级 draft→active。
 */
import type { Scenario } from "./types.js";
import { mineSkillCandidates, promotableCandidates } from "../../src/agent/skill-miner.js";
import { SkillRegistry } from "../../src/agent/skill-registry.js";
import type { StepTrace } from "../../src/agent/types.js";
import type { SkillCandidate } from "../../src/agent/skill-miner.js";

/** 构造一条含若干工具调用的 trace。 */
function makeRun(toolNames: string[], opts: { success?: boolean; inferred?: boolean } = {}): StepTrace[] {
  const { success = true, inferred = false } = opts;
  const result: Record<string, unknown> = {};
  if (inferred) {
    result.data = {};
    result.freshness = "realtime";
    result.capturedAt = "2026-06-20T00:00:00Z";
    result.confidence = "inferred";
    result.source = { system: "llm", provenance: "x" };
  }
  return [
    {
      stepNumber: 0,
      thought: "t",
      toolCalls: toolNames.map((name, i) => ({
        id: `tc${i}`,
        toolName: name,
        args: {},
        result: Object.keys(result).length > 0 ? result : {},
        durationMs: 0,
      })),
      finishReason: success ? "stop" : "error",
      usage: { totalTokens: 100 },
      durationMs: 0,
    },
  ];
}

const OEE_DIAG = ["oee.realtime", "oee.decompose", "equipment.downtime", "process.parameters"];

export const scenarioL1MiningPromotable: Scenario = {
  id: "L1",
  layer: "L",
  title: "高频成功工具序列 → skill-miner 产出候选",
  hypothesis: "OEE 诊断四步序列在 3 条 trace 里都成功出现，无反信号",
  purpose: "验证三硬信号 AND（重复度≥3 + 成本占比>60% + 成功率≥80%）同时满足时产出候选",
  procedure: [
    "构造 3 条相同 OEE 四步序列的成功 trace",
    "调用 promotableCandidates(runs)",
    "断言返回含 oee.realtime 签名的候选",
  ],
  calls: [
    { target: "mineSkillCandidates / promotableCandidates", kind: "real", note: "真实挖矿引擎（4-gram 聚类 + 三信号 AND）" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的高频成功轨迹" },
  ],
  assertions: [
    {
      name: "三信号满足 → 产出候选",
      expected: "promotableCandidates 返回含 oee.realtime 签名",
    },
  ],
  async run() {
    const runs = [makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG)];
    const cands = promotableCandidates(runs);
    const hit = cands.find((c) => c.signature.includes("oee.realtime"));
    this.assertions[0]!.actual = `返回 ${cands.length} 个候选，含 OEE=${!!hit}`;
    this.assertions[0]!.passed = Boolean(hit);
  },
};

export const scenarioL2VetoedByAntiSignal: Scenario = {
  id: "L2",
  layer: "L",
  title: "含 inferred 硬结论的轨迹 → 反信号一票否决",
  hypothesis: "OEE 四步序列在 3 条 trace 出现，但其中 1 条含 inferred 证据",
  purpose: "验证反信号（inferred）一票否决，候选不进入 promotable 列表",
  procedure: [
    "构造 3 条 trace，第 3 条的最后一个工具返回 inferred 证据",
    "调用 mineSkillCandidates(runs)",
    "断言候选 vetoed=true，promotableCandidates 不含它",
  ],
  calls: [
    { target: "mineSkillCandidates", kind: "real", note: "真实反信号检测（isEvidenceEnvelope + confidence=inferred）" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓含 inferred 证据的轨迹" },
  ],
  assertions: [
    {
      name: "inferred 反信号 → vetoed",
      expected: "mineSkillCandidates 返回 vetoed=true；promotableCandidates 不含",
    },
  ],
  async run() {
    const runs = [makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG, { inferred: true })];
    const all = mineSkillCandidates(runs);
    const cand = all.find((c) => c.signature.includes("oee.realtime"));
    const promotable = promotableCandidates(runs);
    const notInPromotable = !promotable.find((c) => c.signature.includes("oee.realtime"));
    this.assertions[0]!.actual = `候选 vetoed=${cand?.vetoed}, promotable 不含=${notInPromotable}`;
    this.assertions[0]!.passed = cand?.vetoed === true && notInPromotable;
  },
};

export const scenarioL3RegistryPromote: Scenario = {
  id: "L3",
  layer: "L",
  title: "draft skill 连续成功 → SkillRegistry 转正 active",
  hypothesis: "一个 draft skill 连续 3 次成功运行（无反信号）",
  purpose: "验证 SkillRegistry 的升级计数：consecutiveSuccess 达阈值（3）后 draft→active",
  procedure: [
    "新建 SkillRegistry（临时文件）",
    "registerDraftSkill 登记一个 draft",
    "连续 3 次 recordDraftRun(name, true)",
    "断言第 3 次返回 promoted=true，且 activeSkills 含此 skill",
  ],
  calls: [
    { target: "SkillRegistry (registerDraftSkill / recordDraftRun)", kind: "real", note: "真实跨会话生命周期管理 + 本地 JSON 持久化" },
    { target: "持久化路径", kind: "synthetic", note: "临时目录（mkdtemp），非生产 data/skills.json" },
  ],
  assertions: [
    {
      name: "连续 3 次成功 → 转正",
      expected: "第 3 次 promoted=true, activeSkills 含此 skill",
    },
    {
      name: "中间态仍 draft",
      expected: "第 2 次后仍 draft（未达阈值）",
    },
  ],
  async run() {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scn-l3-"));
    try {
      const reg = new SkillRegistry(join(dir, "skills.json"));
      reg.registerDraftSkill({ name: "skill.x", signature: "a→b→c→d", stepsPayload: [] });
      reg.recordDraftRun("skill.x", true);
      reg.recordDraftRun("skill.x", true);
      const stillDraft = reg.draftSkills().length === 1 && reg.activeSkills().length === 0;
      this.assertions[1]!.actual = `2 次后 draft=${reg.draftSkills().length}, active=${reg.activeSkills().length}`;
      this.assertions[1]!.passed = stillDraft;

      const r = reg.recordDraftRun("skill.x", true);
      this.assertions[0]!.actual = `第 3 次 promoted=${r.promoted}, active=${reg.activeSkills().length}`;
      this.assertions[0]!.passed = r.promoted && reg.activeSkills().some((s) => s.name === "skill.x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const scenarioL4RegistryDismiss: Scenario = {
  id: "L4",
  layer: "L",
  title: "用户忽略候选 2 次 → 不再提示（降权）",
  hypothesis: "同一候选被用户 dismiss 2 次",
  purpose: "验证 dismissedCount 达阈值后，promotableCandidates 不再返回该候选",
  procedure: [
    "registerCandidates 登记一个候选",
    "dismissCandidate 2 次",
    "断言 promotableCandidates 不含此候选",
  ],
  calls: [
    { target: "SkillRegistry (dismissCandidate / promotableCandidates)", kind: "real", note: "真实降权逻辑" },
    { target: "SkillCandidate 输入", kind: "synthetic", note: "手搓候选对象" },
  ],
  assertions: [
    {
      name: "dismiss 2 次后不再提示",
      expected: "promotableCandidates 不含此签名",
    },
  ],
  async run() {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scn-l4-"));
    try {
      const reg = new SkillRegistry(join(dir, "skills.json"));
      const cand: SkillCandidate = {
        signature: "a→b→c→d", occurrences: 3, vetoed: false,
        signals: { repeatMet: true, costMet: true, successMet: true, costRatio: 0.8, successRatio: 1 },
        sampleTrace: [],
      };
      reg.registerCandidates([cand]);
      reg.dismissCandidate("a→b→c→d");
      reg.dismissCandidate("a→b→c→d");
      const promotable = reg.promotableCandidates();
      const suppressed = !promotable.some((c) => c.signature === "a→b→c→d");
      this.assertions[0]!.actual = `promotable ${promotable.length} 个，含此候选=${!suppressed}`;
      this.assertions[0]!.passed = suppressed;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const scenarioL5MultiTurnFollowUp: Scenario = {
  id: "L5",
  layer: "L",
  title: "多轮追问：上一轮 done task → 追问轮注入压缩上下文",
  hypothesis: "用户首轮得出分析报告后，基于上轮结果继续追问（如'深挖 OEE 损失'）",
  purpose: "验证会话链聚合（ConversationStore）+ compressTrace 能把上一轮取证轨迹压成上下文，供追问轮的 ReAct harness 注入",
  procedure: [
    "在临时 data 目录创建首轮 task，标记 done，并持久化 extension(step_trace) 事件",
    "创建追问 task（同一 conversationId，parentTaskId 指向首轮）",
    "用 ConversationStore.getLatestCompleted 取上一轮 done task",
    "从上一轮 events 读回 step_trace，用 compressTrace 压成 traceDigest",
    "构造 previousContext（intent + traceDigest + finalText）并断言内容完整",
  ],
  calls: [
    { target: "FileTaskStore (create/setStatus/append/readByType)", kind: "real", note: "真实任务存储 + 事件落库 + 读取" },
    { target: "ConversationStore (getLatestCompleted)", kind: "real", note: "真实会话链聚合（按 conversationId 扫描 meta）" },
    { target: "compressTrace", kind: "real", note: "真实轨迹压缩（复用 review-pass 的产物）" },
    { target: "StepTrace / finalText", kind: "synthetic", note: "手搓的上一轮取证轨迹（模拟 ReAct 产出）" },
  ],
  assertions: [
    {
      name: "会话聚合找到上一轮 done task",
      expected: "getLatestCompleted 返回首轮 task（非 null）",
    },
    {
      name: "压缩上下文含上一轮意图 + 轨迹 + 结论",
      expected: "previousContext.intent/traceDigest/finalText 均非空，traceDigest 含 Thought",
    },
    {
      name: "失败状态 task 不被选为 parent",
      expected: "把首轮改为 error 后，getLatestCompleted 返回 null（不把失败上下文喂给 LLM）",
    },
  ],
  async run() {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileTaskStore } = await import("../../src/tasks/task-store.js");
    const { ConversationStore } = await import("../../src/tasks/conversation-store.js");
    const { compressTrace } = await import("../../src/agent/review-pass.js");
    type StepTrace = import("../../src/agent/types.js").StepTrace;
    type StreamEvent = import("../../src/core/stream-events.js").StreamEvent;

    const dir = mkdtempSync(join(tmpdir(), "scn-l5-"));
    const prevDataDir = process.env.LIF_DATA_DIR;
    process.env.LIF_DATA_DIR = dir;
    try {
      const store = new FileTaskStore();
      const convStore = new ConversationStore(store);

      // 首轮 task：done + 持久化 stepTrace
      const first = store.create("诊断 L01 OEE 偏低原因");
      store.setStatus(first.id, "done");
      const trace: StepTrace[] = [
        {
          stepNumber: 0,
          thought: "先查 L01 实时 OEE 看损失结构",
          toolCalls: [{
            id: "tc_1", toolName: "oee.realtime", args: { line: "L01" },
            result: { data: { oee: 0.65, availability: 0.9, performance: 0.72, quality: 0.99 } },
            durationMs: 120,
          }],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          durationMs: 200,
        },
      ];
      const finalText = "L01 OEE=0.65，主要损失在性能率（0.72），疑为设备降速";
      store.append(first.id, {
        type: "extension", taskId: first.id, ts: Date.now(), channel: "status",
        payload: { name: "step_trace", version: "1.0", data: { stepTrace: trace, finalText } },
      } as Omit<StreamEvent, "seq">);

      // 断言1：会话聚合找到上一轮 done task
      const latest = convStore.getLatestCompleted(first.conversationId!);
      this.assertions[0]!.actual = `getLatestCompleted = ${latest?.id ?? "null"}`;
      this.assertions[0]!.passed = latest?.id === first.id;

      // 断言2：从 events 读回 stepTrace → compressTrace → 构造 previousContext
      const events = store.readByType(first.id, "extension");
      const stEvent = events.find(
        (e) => (e.payload as { name?: string }).name === "step_trace",
      );
      const stData = (stEvent!.payload as { data: { stepTrace: StepTrace[]; finalText: string } }).data;
      const previousContext = {
        intent: latest!.intent,
        traceDigest: compressTrace(stData.stepTrace),
        finalText: stData.finalText,
      };
      const hasIntent = previousContext.intent.includes("OEE");
      const hasDigest = previousContext.traceDigest.includes("Thought");
      const hasFinal = previousContext.finalText.includes("0.65");
      this.assertions[1]!.actual = `intent非空=${hasIntent}, digest含Thought=${hasDigest}, final含结论=${hasFinal}`;
      this.assertions[1]!.passed = hasIntent && hasDigest && hasFinal;

      // 断言3：失败状态 task 不被选为 parent
      store.setStatus(first.id, "error", "模拟失败");
      const failed = convStore.getLatestCompleted(first.conversationId!);
      this.assertions[2]!.actual = `改为 error 后 getLatestCompleted = ${failed?.id ?? "null"}`;
      this.assertions[2]!.passed = failed === null;
    } finally {
      if (prevDataDir === undefined) delete process.env.LIF_DATA_DIR;
      else process.env.LIF_DATA_DIR = prevDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const lLayerScenarios: Scenario[] = [scenarioL1MiningPromotable, scenarioL2VetoedByAntiSignal, scenarioL3RegistryPromote, scenarioL4RegistryDismiss, scenarioL5MultiTurnFollowUp];
