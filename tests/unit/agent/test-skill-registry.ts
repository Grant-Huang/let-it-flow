/**
 * skill-registry 单测（D3）。
 *
 * 验证：
 *   - 跨会话去重：同签名 occurrences 累加
 *   - 已忽略降权：dismissedCount 达阈值后不再 promotable
 *   - draft→active 升级：连续成功 N 次转正
 *   - draft 降级：连续失败 N 次删除
 *   - 持久化：load/save 往返
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry, type CandidateRecord, type SkillRecord } from "../../src/agent/skill-registry.js";
import type { SkillCandidate } from "../../src/agent/skill-miner.js";

let dataDir: string;
let filePath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "skill-reg-"));
  filePath = join(dataDir, "skills.json");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 构造一个候选。 */
function makeCand(signature: string, occurrences = 3, vetoed = false): SkillCandidate {
  return {
    signature,
    occurrences,
    signals: { repeatMet: true, costMet: true, successMet: true, costRatio: 0.8, successRatio: 1 },
    vetoed,
    sampleTrace: [],
  };
}

describe("SkillRegistry 候选去重", () => {
  it("新候选 → 登记成功", () => {
    const reg = new SkillRegistry(filePath);
    const updated = reg.registerCandidates([makeCand("a→b→c→d")]);
    expect(updated.length).toBe(1);
    expect(updated[0]!.occurrences).toBe(3);
    expect(reg.promotableCandidates().length).toBe(1);
  });

  it("同签名重复登记 → occurrences 累加", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d", 3)]);
    reg.registerCandidates([makeCand("a→b→c→d", 2)]);
    const cands = reg.promotableCandidates();
    expect(cands.length).toBe(1);
    expect(cands[0]!.occurrences).toBe(5);
  });

  it("vetoed 候选不登记", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d", 3, true)]);
    expect(reg.promotableCandidates().length).toBe(0);
  });

  it("不同签名各自登记", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d"), makeCand("e→f→g→h")]);
    expect(reg.promotableCandidates().length).toBe(2);
  });
});

describe("SkillRegistry 已忽略降权", () => {
  it("dismiss < 阈值 → 仍 promotable", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d")]);
    reg.dismissCandidate("a→b→c→d");
    expect(reg.promotableCandidates().length).toBe(1);
  });

  it("dismiss >= 阈值(2) → 不再 promotable", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d")]);
    reg.dismissCandidate("a→b→c→d");
    reg.dismissCandidate("a→b→c→d");
    expect(reg.promotableCandidates().length).toBe(0);
  });

  it("promotable 按 occurrences 降序", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("low", 3), makeCand("high", 10)]);
    const cands = reg.promotableCandidates();
    expect(cands[0]!.signature).toBe("high");
    expect(cands[1]!.signature).toBe("low");
  });
});

describe("SkillRegistry acceptCandidate", () => {
  it("accept → 从候选列表移除", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerCandidates([makeCand("a→b→c→d")]);
    const rec = reg.acceptCandidate("a→b→c→d");
    expect(rec).toBeDefined();
    expect(reg.promotableCandidates().length).toBe(0);
  });

  it("accept 不存在的签名 → undefined", () => {
    const reg = new SkillRegistry(filePath);
    expect(reg.acceptCandidate("不存在")).toBeUndefined();
  });
});

describe("SkillRegistry draft→active 升级", () => {
  function makeDraftRecord(name: string): Omit<SkillRecord, "status" | "consecutiveSuccess" | "consecutiveFailure" | "createdAt"> {
    return { name, signature: "a→b→c→d", stepsPayload: [] };
  }

  it("连续成功 < 3 → 仍 draft", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerDraftSkill(makeDraftRecord("skill.x"));
    const r = reg.recordDraftRun("skill.x", true);
    reg.recordDraftRun("skill.x", true);
    expect(r.promoted).toBe(false);
    expect(reg.draftSkills().length).toBe(1);
    expect(reg.activeSkills().length).toBe(0);
  });

  it("连续成功 >= 3 → 转正 active", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerDraftSkill(makeDraftRecord("skill.x"));
    reg.recordDraftRun("skill.x", true);
    reg.recordDraftRun("skill.x", true);
    const r = reg.recordDraftRun("skill.x", true);
    expect(r.promoted).toBe(true);
    expect(reg.draftSkills().length).toBe(0);
    expect(reg.activeSkills().length).toBe(1);
  });

  it("成功后失败 → consecutiveSuccess 清零", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerDraftSkill(makeDraftRecord("skill.x"));
    reg.recordDraftRun("skill.x", true);
    reg.recordDraftRun("skill.x", true);
    reg.recordDraftRun("skill.x", false); // 清零
    reg.recordDraftRun("skill.x", true);
    reg.recordDraftRun("skill.x", true);
    // 只有 2 次连续成功，未达 3
    expect(reg.draftSkills().length).toBe(1);
    expect(reg.activeSkills().length).toBe(0);
  });

  it("连续失败 >= 3 → 删除 draft", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerDraftSkill(makeDraftRecord("skill.x"));
    reg.recordDraftRun("skill.x", false);
    reg.recordDraftRun("skill.x", false);
    const r = reg.recordDraftRun("skill.x", false);
    expect(r.demoted).toBe(true);
    expect(reg.draftSkills().length).toBe(0);
  });
});

describe("SkillRegistry 持久化", () => {
  it("save → load 往返（候选保留）", () => {
    const reg1 = new SkillRegistry(filePath);
    reg1.registerCandidates([makeCand("a→b→c→d", 5)]);
    expect(existsSync(filePath)).toBe(true);

    const reg2 = new SkillRegistry(filePath);
    const cands = reg2.promotableCandidates();
    expect(cands.length).toBe(1);
    expect(cands[0]!.occurrences).toBe(5);
  });

  it("save → load 往返（draft/active skill 保留）", () => {
    const reg1 = new SkillRegistry(filePath);
    reg1.registerDraftSkill({ name: "skill.x", signature: "a→b→c→d", stepsPayload: { steps: 4 } });
    reg1.recordDraftRun("skill.x", true);
    reg1.recordDraftRun("skill.x", true);
    reg1.recordDraftRun("skill.x", true); // 转正

    const reg2 = new SkillRegistry(filePath);
    expect(reg2.activeSkills().length).toBe(1);
    expect(reg2.activeSkills()[0]!.name).toBe("skill.x");
  });

  it("文件不存在 → 空内存态（不抛错）", () => {
    const reg = new SkillRegistry(join(dataDir, "不存在.json"));
    expect(reg.promotableCandidates()).toEqual([]);
    expect(reg.activeSkills()).toEqual([]);
  });

  it("文件损坏 → 空内存态（不抛错）", () => {
    writeFileSync(filePath, "{ 不是合法 JSON", "utf8");
    const reg = new SkillRegistry(filePath);
    expect(reg.promotableCandidates()).toEqual([]);
  });
});
