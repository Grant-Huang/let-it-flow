/**
 * extension-presets 单测（R3 协议层）。
 *
 * 验证预设子类型 payload helper 与 stream-events.ts 现有 confirmGatePayload 风格一致。
 *
 * 注：本测试不依赖 meso 包升级（2.2.0）—— ExtensionPayload 类型在 2.1.1 已存在。
 *     预设的"语义归约"逻辑由 meso 包 applyEvent 实现（见 docs/26-meso-packages-extension-requirements.md）。
 *     本测试只验证平台层构造的 payload 形状正确。
 */
import { describe, it, expect } from "vitest";
import {
  EXTENSION_PRESETS,
  preconditionUnmetPayload,
  artifactsPayload,
  reactResultPayload,
  stepTracePayload,
  type ArtifactItem,
} from "../../../src/core/extension-presets.js";

describe("EXTENSION_PRESETS 注册表（从 meso 包 2.2.0 re-export）", () => {
  it("包含 4 个预设子类型（meso 2.2.0 未含 confirm_gate，由 tool_status 联动处理）", () => {
    expect(Object.keys(EXTENSION_PRESETS).sort()).toEqual([
      "artifacts",
      "precondition_unmet",
      "react_result",
      "step_trace",
    ]);
  });

  it("每个预设带 version", () => {
    for (const [name, spec] of Object.entries(EXTENSION_PRESETS)) {
      expect(spec.version, `${name} 应有 version`).toMatch(/^\d+\.\d+$/);
    }
  });

  it("artifacts / step_trace 带别名（向后兼容旧 name）", () => {
    expect(EXTENSION_PRESETS.artifacts?.aliases).toContain("nexus_artifacts");
    expect(EXTENSION_PRESETS.step_trace?.aliases).toContain("react_step_trace");
  });
});

describe("preconditionUnmetPayload", () => {
  it("构造正确的 ExtensionPayload", () => {
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    const p = preconditionUnmetPayload({
      finishReason: "precondition_unmet",
      finalText: "缺 OEE 数据",
      usage,
      missingDomains: ["OEE"],
    });
    expect(p.name).toBe("precondition_unmet");
    expect(p.version).toBe("1.0");
    expect(p.data).toEqual({
      finishReason: "precondition_unmet",
      finalText: "缺 OEE 数据",
      usage,
      missingDomains: ["OEE"],
    });
  });

  it("finalText / usage / missingDomains 可选", () => {
    const p = preconditionUnmetPayload({ finishReason: "precondition_unmet" });
    expect((p.data as { finalText?: string }).finalText).toBeUndefined();
  });
});

describe("artifactsPayload", () => {
  it("构造 items 列表", () => {
    const items: ArtifactItem[] = [
      { id: "a1", type: "report_html", title: "OEE 报告", description: "7月数据" },
      { id: "a2", type: "mermaid", title: "因果图" },
    ];
    const p = artifactsPayload({ items });
    expect(p.name).toBe("artifacts");
    expect(p.version).toBe("1.0");
    expect((p.data as { items: ArtifactItem[] }).items).toHaveLength(2);
    expect((p.data as { items: ArtifactItem[] }).items[0]!.title).toBe("OEE 报告");
    expect((p.data as { items: ArtifactItem[] }).items[0]!.id).toBe("a1");
  });

  it("空 items 合法（兼容无产物场景）", () => {
    const p = artifactsPayload({ items: [] });
    expect((p.data as { items: unknown[] }).items).toEqual([]);
  });
});

describe("reactResultPayload", () => {
  it("构造收尾摘要", () => {
    const p = reactResultPayload({
      finishReason: "finalize_tool",
      stepCount: 5,
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });
    expect(p.name).toBe("react_result");
    expect(p.version).toBe("1.0");
    const d = p.data as { finishReason: string; stepCount: number; usage: object };
    expect(d.finishReason).toBe("finalize_tool");
    expect(d.stepCount).toBe(5);
    expect(d.usage).toEqual({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
  });
});

describe("stepTracePayload", () => {
  it("构造轨迹 digest", () => {
    const trace = [{ stepNumber: 0, thought: "分析", toolCalls: [] }];
    const p = stepTracePayload({ stepTrace: trace, finalText: "结论" });
    expect(p.name).toBe("step_trace");
    expect(p.version).toBe("1.0");
    expect((p.data as { stepTrace: unknown[]; finalText: string }).stepTrace).toEqual(trace);
    expect((p.data as { stepTrace: unknown[]; finalText: string }).finalText).toBe("结论");
  });
});
