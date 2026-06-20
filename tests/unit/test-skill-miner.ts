/**
 * skill-miner 单测（D2）。
 *
 * 验证：
 *   - 三硬信号 AND：重复度/成本/成功率
 *   - 反信号一票否决（inferred/governance 阻断/HITL 拒绝/skill errors）
 *   - promotableCandidates 只返回全满足 + 未否决的候选
 */
import { describe, it, expect } from "vitest";
import { mineSkillCandidates, promotableCandidates } from "../../src/agent/skill-miner.js";
import type { StepTrace } from "../../src/agent/types.js";

/** 构造一条含若干工具调用的 trace。 */
function makeRun(toolNames: string[], opts: { success?: boolean; rejected?: boolean; inferred?: boolean; blocked?: boolean; skillErrors?: boolean } = {}): StepTrace[] {
  const { success = true, rejected = false, inferred = false, blocked = false, skillErrors = false } = opts;
  const result: Record<string, unknown> = {};
  if (inferred) {
    result.data = {};
    result.freshness = "realtime";
    result.capturedAt = "2026-06-20T00:00:00Z";
    result.confidence = "inferred";
    result.source = { system: "llm", provenance: "x" };
  }
  if (blocked) result.blocked = true;
  if (skillErrors) result._skill = { errors: ["步骤失败"] };
  return [
    {
      stepNumber: 0,
      thought: "t",
      toolCalls: toolNames.map((name, i) => ({
        id: `tc${i}`,
        toolName: name,
        args: {},
        result: Object.keys(result).length > 0 ? result : {},
        rejected,
        durationMs: 0,
      })),
      finishReason: success ? "stop" : "error",
      usage: { totalTokens: 100 },
      durationMs: 0,
    },
  ];
}

/** 常用的 4-gram 序列（OEE 诊断套路）。 */
const OEE_DIAG = ["oee.realtime", "oee.decompose", "equipment.downtime", "process.parameters"];

describe("mineSkillCandidates 三硬信号 AND", () => {
  it("重复度不足（<3 次）→ 不出现在候选", () => {
    const runs = [makeRun(OEE_DIAG), makeRun(OEE_DIAG)]; // 仅 2 次
    const cands = mineSkillCandidates(runs);
    expect(cands.find((c) => c.signature.includes("oee.realtime"))).toBeUndefined();
  });

  it("重复度达标（≥3 次）且全部成功 → 出现候选，三信号全满足", () => {
    const runs = [makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG)];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.signals.repeatMet).toBe(true);
    expect(cand!.signals.successMet).toBe(true);
    expect(cand!.vetoed).toBe(false);
  });

  it("成功率不足（<80%）→ successMet=false", () => {
    // 5 次，1 次失败 = 80%，刚好等于阈值（≥0.8 满足）；用 5 次 2 失败 = 60% 不满足
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { success: false }), makeRun(OEE_DIAG, { success: false }),
    ];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.signals.successMet).toBe(false);
  });

  it("序列长（n-gram 占比低）→ costMet=false", () => {
    // 序列有 10 个工具，4-gram 占比 4/10=0.4 < 0.6
    const longSeq = [...OEE_DIAG, "quality.pareto", "quality.defects", "energy.realtime", "schedule.current", "material.wip", "core.web_search"];
    const runs = [makeRun(longSeq), makeRun(longSeq), makeRun(longSeq)];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.signals.costMet).toBe(false);
  });
});

describe("mineSkillCandidates 反信号一票否决", () => {
  it("含 inferred 证据 → vetoed=true", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { inferred: true }),
    ];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.vetoed).toBe(true);
    expect(cand!.sampleTrace).toBeUndefined();
  });

  it("含 governance 阻断 → vetoed=true", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { blocked: true }),
    ];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.vetoed).toBe(true);
  });

  it("含 HITL 拒绝 → vetoed=true", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { rejected: true }),
    ];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.vetoed).toBe(true);
  });

  it("含 skill errors → vetoed=true", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { skillErrors: true }),
    ];
    const cands = mineSkillCandidates(runs);
    const cand = cands.find((c) => c.signature.includes("oee.realtime"));
    expect(cand).toBeDefined();
    expect(cand!.vetoed).toBe(true);
  });
});

describe("promotableCandidates 只返回可提示的", () => {
  it("全满足 + 无反信号 → 出现在结果", () => {
    const runs = [makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG)];
    const promotable = promotableCandidates(runs);
    expect(promotable.length).toBeGreaterThan(0);
    expect(promotable.every((c) => !c.vetoed)).toBe(true);
    expect(promotable.every((c) => c.sampleTrace)).toBe(true);
  });

  it("含反信号 → 不出现在结果（即便重复度高够）", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { inferred: true }),
    ];
    const promotable = promotableCandidates(runs);
    expect(promotable.find((c) => c.signature.includes("oee.realtime"))).toBeUndefined();
  });

  it("成功率不足 → 不出现在结果", () => {
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(OEE_DIAG, { success: false }), makeRun(OEE_DIAG, { success: false }),
    ];
    const promotable = promotableCandidates(runs);
    expect(promotable.find((c) => c.signature.includes("oee.realtime"))).toBeUndefined();
  });
});

describe("mineSkillCandidates 边界", () => {
  it("空 runs → 空候选", () => {
    expect(mineSkillCandidates([])).toEqual([]);
  });

  it("序列长度 < n-gram（4）→ 跳过该 trace", () => {
    const short = ["oee.realtime", "oee.decompose"];
    const runs = [makeRun(short), makeRun(short), makeRun(short)];
    expect(mineSkillCandidates(runs)).toEqual([]);
  });

  it("候选按 occurrences 降序", () => {
    // OEE_DIAG 出现 3 次，另一序列出现 4 次
    const other = ["quality.pareto", "quality.defects", "process.parameters", "oee.quality_loss"];
    const runs = [
      makeRun(OEE_DIAG), makeRun(OEE_DIAG), makeRun(OEE_DIAG),
      makeRun(other), makeRun(other), makeRun(other), makeRun(other),
    ];
    const cands = mineSkillCandidates(runs).filter((c) => !c.vetoed);
    expect(cands.length).toBeGreaterThan(1);
    expect(cands[0]!.occurrences).toBeGreaterThanOrEqual(cands[1]!.occurrences);
  });
});
