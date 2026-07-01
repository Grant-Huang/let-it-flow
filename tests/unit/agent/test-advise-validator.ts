/**
 * advise-validator 单测（B3 输出结构自检）。
 *
 * 验证 validateAdvise 的字段完整性 / 数值范围 / 证据引用 warn 三类检查。
 */
import { describe, it, expect } from "vitest";
import { validateAdvise } from "../../../apps/nexusops/tools/advise-validator.js";

describe("validateAdvise 字段完整性", () => {
  it("空建议列表 → invalid", () => {
    const r = validateAdvise([]);
    expect(r.valid).toBe(false);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain("空");
  });

  it("缺必填字段 → invalid + 列出缺失字段", () => {
    const r = validateAdvise([{ title: "调温度", rationale: "偏差大" }]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("impact"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("executionScore"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("confidence"))).toBe(true);
  });

  it("title/rationale 空字符串 → invalid", () => {
    const r = validateAdvise([
      { title: "   ", rationale: "", impact: 0.5, executionScore: 0.5, confidence: 0.5 },
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("title"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("rationale"))).toBe(true);
  });

  it("全部字段齐全且合规 → valid", () => {
    const r = validateAdvise([
      {
        title: "校准温度参数至标准值",
        rationale: "工艺温度偏差 +6.5%",
        impact: 0.8,
        executionScore: 0.9,
        confidence: 0.85,
        evidenceRefs: ["process.parameters"],
      },
    ]);
    expect(r.valid).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe("validateAdvise 数值范围", () => {
  it("impact > 1 → invalid", () => {
    const r = validateAdvise([
      { title: "t", rationale: "r", impact: 1.5, executionScore: 0.5, confidence: 0.5 },
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("impact"))).toBe(true);
  });

  it("executionScore < 0 → invalid", () => {
    const r = validateAdvise([
      { title: "t", rationale: "r", impact: 0.5, executionScore: -0.1, confidence: 0.5 },
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("executionScore"))).toBe(true);
  });

  it("confidence 为字符串 → invalid", () => {
    const r = validateAdvise([
      { title: "t", rationale: "r", impact: 0.5, executionScore: 0.5, confidence: "高" },
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("confidence"))).toBe(true);
  });

  it("边界值 0 和 1 → valid", () => {
    const r = validateAdvise([
      { title: "t", rationale: "r", impact: 0, executionScore: 1, confidence: 0 },
    ]);
    expect(r.valid).toBe(true);
  });
});

describe("validateAdvise 证据引用 warn", () => {
  it("无 evidenceRefs → valid 但有 warn", () => {
    const r = validateAdvise([
      { title: "t", rationale: "r", impact: 0.5, executionScore: 0.5, confidence: 0.5 },
    ]);
    expect(r.valid).toBe(true);
    expect(r.evidenceRefWarnings.length).toBe(1);
    expect(r.evidenceRefWarnings[0]).toContain("evidenceRefs");
  });

  it("有 evidenceRefs → 无 warn", () => {
    const r = validateAdvise([
      {
        title: "t",
        rationale: "r",
        impact: 0.5,
        executionScore: 0.5,
        confidence: 0.5,
        evidenceRefs: ["oee.realtime"],
      },
    ]);
    expect(r.valid).toBe(true);
    expect(r.evidenceRefWarnings).toEqual([]);
  });

  it("evidenceRefs 为空数组 → 有 warn", () => {
    const r = validateAdvise([
      {
        title: "t",
        rationale: "r",
        impact: 0.5,
        executionScore: 0.5,
        confidence: 0.5,
        evidenceRefs: [],
      },
    ]);
    expect(r.evidenceRefWarnings.length).toBe(1);
  });
});

describe("validateAdvise 多条建议", () => {
  it("第二条建议有问题 → 精确定位到 #2", () => {
    const r = validateAdvise([
      { title: "t1", rationale: "r1", impact: 0.5, executionScore: 0.5, confidence: 0.5, evidenceRefs: ["a"] },
      { title: "t2", rationale: "r2", impact: 2, executionScore: 0.5, confidence: 0.5 },
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("#2"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("#1"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evidenceRefs 白名单校验（knownToolPattern）
// ─────────────────────────────────────────────────────────────────────────────

const NEXUS_PATTERN = /^(oee|equipment|quality|process|energy|schedule|material|personnel|core|skill|mcp)\./;

describe("validateAdvise evidenceRefs 白名单校验", () => {
  it("evidenceRefs 全合法（匹配前缀）→ valid", () => {
    const r = validateAdvise(
      [
        {
          title: "t",
          rationale: "r",
          impact: 0.5,
          executionScore: 0.5,
          confidence: 0.5,
          evidenceRefs: ["oee.realtime", "equipment.downtime", "process.deviation"],
        },
      ],
      { knownToolPattern: NEXUS_PATTERN },
    );
    expect(r.valid).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("evidenceRefs 含无效工具名（如 mes.get_oee）→ invalid", () => {
    const r = validateAdvise(
      [
        {
          title: "t",
          rationale: "r",
          impact: 0.5,
          executionScore: 0.5,
          confidence: 0.5,
          evidenceRefs: ["oee.realtime", "mes.get_oee"],
        },
      ],
      { knownToolPattern: NEXUS_PATTERN },
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("mes.get_oee"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("无效工具名"))).toBe(true);
  });

  it("evidenceRefs 无前缀（裸工具名如 get_oee）→ invalid", () => {
    const r = validateAdvise(
      [
        {
          title: "t",
          rationale: "r",
          impact: 0.5,
          executionScore: 0.5,
          confidence: 0.5,
          evidenceRefs: ["get_oee"],
        },
      ],
      { knownToolPattern: NEXUS_PATTERN },
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("get_oee"))).toBe(true);
  });

  it("evidenceRefs 含非字符串元素 → invalid", () => {
    const r = validateAdvise(
      [
        {
          title: "t",
          rationale: "r",
          impact: 0.5,
          executionScore: 0.5,
          confidence: 0.5,
          evidenceRefs: ["oee.realtime", 123],
        },
      ],
      { knownToolPattern: NEXUS_PATTERN },
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("无效工具名"))).toBe(true);
  });

  it("不传 knownToolPattern → 不做白名单校验（向后兼容）", () => {
    const r = validateAdvise([
      {
        title: "t",
        rationale: "r",
        impact: 0.5,
        executionScore: 0.5,
        confidence: 0.5,
        evidenceRefs: ["totally_fake_tool"],
      },
    ]);
    expect(r.valid).toBe(true);
    expect(r.evidenceRefWarnings).toEqual([]);
  });

  it("core/skill/mcp 前缀也合法", () => {
    const r = validateAdvise(
      [
        {
          title: "t",
          rationale: "r",
          impact: 0.5,
          executionScore: 0.5,
          confidence: 0.5,
          evidenceRefs: ["core.knowledge_base", "skill.oee_diagnose", "mcp.mes.schedule_work_order"],
        },
      ],
      { knownToolPattern: NEXUS_PATTERN },
    );
    expect(r.valid).toBe(true);
  });
});
