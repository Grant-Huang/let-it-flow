/**
 * MockOrchestrator 单测（Phase 0.12）。
 *
 * 验证：
 *   - 9 场景因果链查询（含空链）
 *   - 8 方法论查询（6 full + 2 minimal + qs16949）
 *   - 证据契约查询
 *   - syncToolIndex 回写
 *   - source 恒为 "mock"
 *   - 文件不存在时降级（不抛错）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockOrchestrator } from "../../../src/orchestrator/mock-orchestrator.js";
import type { BizContext } from "../../../src/orchestrator/types.js";

const REAL_DATA_DIR = join(process.cwd(), "data", "relos-mock");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mock-orch-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MockOrchestrator - 真实 mock 数据", () => {
  it("getMethodology('dmaic') 返回完整结构化方法论", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const m = await orch.getMethodology("dmaic", {});
    expect(m).not.toBeNull();
    expect(m!.topic).toBe("dmaic");
    expect(m!.source).toBe("mock");
    expect(m!.granularity).toBe("full");
    expect(m!.confidence).toBe(0.95);
    expect(m!.phases.length).toBe(5);
    expect(m!.phases[0]!.id).toBe("D");
    expect(m!.phases[0]!.blocking).toBe(true);
  });

  it("getMethodology('general_analysis') 返回最小骨架方法论", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const m = await orch.getMethodology("general_analysis", {});
    expect(m).not.toBeNull();
    expect(m!.granularity).toBe("minimal");
    expect(m!.source).toBe("mock");
  });

  it("getMethodology('qs16949_audit') 返回符合性评估方法论", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const m = await orch.getMethodology("qs16949_audit", {});
    expect(m).not.toBeNull();
    expect(m!.topic).toBe("qs16949_audit");
    expect(m!.granularity).toBe("minimal");
    expect(m!.phases.length).toBe(4);
    // evidence 阶段要求四大工具齐备
    const evidencePhase = m!.phases.find((p) => p.id === "evidence");
    expect(evidencePhase).toBeDefined();
    const semantics = evidencePhase!.requiredData.map((d) => d.semantic);
    expect(semantics).toContain("fmea");
    expect(semantics).toContain("process_capability");
    expect(semantics).toContain("spc_samples");
    expect(semantics).toContain("calibration_status");
  });

  it("getMethodology 未知 topic 返回 null", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const m = await orch.getMethodology("nonexistent_topic", {});
    expect(m).toBeNull();
  });

  it("所有方法论 source 恒为 mock", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    for (const topic of ["dmaic", "oee_diagnose", "general_analysis", "qs16949_audit"]) {
      const m = await orch.getMethodology(topic, {});
      expect(m!.source).toBe("mock");
    }
  });
});

describe("MockOrchestrator - 因果链查询", () => {
  it("anomaly/L01 返回主轴轴承磨损链", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "anomaly", line: "L01" };
    const cc = await orch.getCausalChain("尺寸超差", ctx);
    expect(cc).not.toBeNull();
    expect(cc!.source).toBe("mock");
    expect(cc!.chains.length).toBeGreaterThanOrEqual(1);
    expect(cc!.chains[0]!.method).toBe("5why");
    expect(cc!.chains[0]!.layers.length).toBe(5);
    expect(cc!.chains[0]!.rootCause).toContain("润滑泵滤网堵塞");
    // 鱼骨图六分支
    expect(cc!.fishbone.machine.length).toBeGreaterThan(0);
    expect(cc!.fishbone.method.length).toBeGreaterThan(0);
  });

  it("crisis/L01 返回双链（轴承断裂 + 能耗飙升）", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "crisis", line: "L01" };
    const cc = await orch.getCausalChain("报废+停机", ctx);
    expect(cc).not.toBeNull();
    expect(cc!.chains.length).toBe(2);
    // 两条链同根因
    expect(cc!.chains[0]!.rootCause).toContain("预测性维护");
    expect(cc!.chains[1]!.rootCause).toContain("预测性维护");
  });

  it("crisis/L02 返回缺料停机链", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "crisis", line: "L02" };
    const cc = await orch.getCausalChain("缺料停机", ctx);
    expect(cc).not.toBeNull();
    expect(cc!.chains[0]!.rootCause).toContain("安全库存公式");
  });

  it("anomaly/L02 返回温控 PID 漂移链", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "anomaly", line: "L02" };
    const cc = await orch.getCausalChain("尺寸超差", ctx);
    expect(cc).not.toBeNull();
    expect(cc!.chains[0]!.rootCause).toContain("模具寿命校准");
  });

  it("normal 场景无因果链（返回 null）", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "normal", line: "L01" };
    const cc = await orch.getCausalChain("正常", ctx);
    expect(cc).toBeNull();
  });

  it("L03 无因果链（返回 null）", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const ctx: BizContext = { scenarioId: "anomaly", line: "L03" };
    const cc = await orch.getCausalChain("正常", ctx);
    expect(cc).toBeNull();
  });
});

describe("MockOrchestrator - 证据契约", () => {
  it("getEvidenceContract('root_cause_identified') 返回契约", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const c = await orch.getEvidenceContract("root_cause_identified", {});
    expect(c).not.toBeNull();
    expect(c!.source).toBe("mock");
    expect(c!.requiredEvidence.length).toBeGreaterThanOrEqual(2);
    const causalReq = c!.requiredEvidence.find((e) => e.semantic === "causal_chain");
    expect(causalReq).toBeDefined();
    expect(causalReq!.required).toBe(true);
  });

  it("getEvidenceContract('D_complete') 返回 DMAIC D 阶段契约", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const c = await orch.getEvidenceContract("D_complete", {});
    expect(c).not.toBeNull();
    const semantics = c!.requiredEvidence.map((e) => e.semantic);
    expect(semantics).toContain("oee");
    expect(semantics).toContain("process_capability");
    expect(semantics).toContain("cost_summary");
  });

  it("getEvidenceContract('qs16949_evidence_complete') 返回 QS16949 契约", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const c = await orch.getEvidenceContract("qs16949_evidence_complete", {});
    expect(c).not.toBeNull();
    const semantics = c!.requiredEvidence.map((e) => e.semantic);
    expect(semantics).toContain("fmea");
    expect(semantics).toContain("calibration_status");
  });

  it("未知 conclusion 返回 null", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const c = await orch.getEvidenceContract("nonexistent", {});
    expect(c).toBeNull();
  });
});

describe("MockOrchestrator - syncToolIndex", () => {
  it("syncToolIndex 写出 tool-index.json", async () => {
    const orch = new MockOrchestrator(tmpDir);
    const manifest = [
      { name: "quality.cp_cpk", semanticTags: ["process_capability"], description: "Cp/Cpk", whenToUse: { triggers: ["Cpk"], notFor: [] } },
      { name: "oee.realtime", semanticTags: ["oee"], description: "实时 OEE", whenToUse: { triggers: ["OEE"], notFor: [] } },
    ];
    await orch.syncToolIndex(manifest);
    const indexPath = join(tmpDir, "tool-index.json");
    expect(existsSync(indexPath)).toBe(true);
    const raw = JSON.parse(readFileSync(indexPath, "utf8"));
    expect(raw.version).toBe("1.0");
    expect(raw.tools.length).toBe(2);
    expect(raw.tools[0].name).toBe("quality.cp_cpk");
    expect(raw.syncedAt).toBeDefined();
  });
});

describe("MockOrchestrator - 降级", () => {
  it("数据目录不存在时不抛错（降级为空）", () => {
    const orch = new MockOrchestrator(join(tmpDir, "nonexistent"));
    // 构造不抛错
    expect(orch).toBeDefined();
  });

  it("空目录返回 null 方法论", async () => {
    const orch = new MockOrchestrator(tmpDir);
    const m = await orch.getMethodology("dmaic", {});
    expect(m).toBeNull();
  });

  it("空目录返回 null 因果链", async () => {
    const orch = new MockOrchestrator(tmpDir);
    const cc = await orch.getCausalChain("test", { scenarioId: "anomaly", line: "L01" });
    expect(cc).toBeNull();
  });
});

describe("MockOrchestrator - 完整性校验", () => {
  it("所有方法论 phases 都有 requiredData", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const topics = ["dmaic", "oee_diagnose", "downtime_root_cause", "multi_perspective_rca", "cost_summary", "waste_audit", "general_analysis", "energy_analysis", "qs16949_audit"];
    for (const topic of topics) {
      const m = await orch.getMethodology(topic, {});
      expect(m, `方法论 ${topic} 应存在`).not.toBeNull();
      for (const phase of m!.phases) {
        expect(phase.requiredData, `${topic}.${phase.id} 应有 requiredData`).toBeDefined();
      }
    }
  });

  it("因果规则覆盖 4 个有内容场景", async () => {
    const orch = new MockOrchestrator(REAL_DATA_DIR);
    const scenarios = [
      { scenarioId: "anomaly" as const, line: "L01" },
      { scenarioId: "anomaly" as const, line: "L02" },
      { scenarioId: "crisis" as const, line: "L01" },
      { scenarioId: "crisis" as const, line: "L02" },
    ];
    for (const s of scenarios) {
      const cc = await orch.getCausalChain("test", s);
      expect(cc, `${s.scenarioId}/${s.line} 应有因果链`).not.toBeNull();
      expect(cc!.chains.length).toBeGreaterThanOrEqual(1);
    }
  });
});
