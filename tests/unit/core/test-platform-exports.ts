/**
 * 平台公共 API 导出完整性测试（R3/R4/R5）。
 *
 * 确保新增的平台机制（EventBroadcaster / StepBudget / TraceCompressor / extension presets）
 * 都从 @let-it-flow（src/index.ts）正确导出。
 */
import { describe, it, expect } from "vitest";
import * as Lif from "../../../src/index.js";

describe("平台公共导出", () => {
  describe("R1/R2 传输层（补全导出）", () => {
    it("EventBroadcaster 类已导出", () => {
      expect(Lif.EventBroadcaster).toBeDefined();
      expect(typeof Lif.EventBroadcaster).toBe("function");
    });

    it("globalBroadcaster 实例已导出", () => {
      expect(Lif.globalBroadcaster).toBeDefined();
    });
  });

  describe("R4 步数预算", () => {
    it("computeStepBudget 已导出", () => {
      expect(typeof Lif.computeStepBudget).toBe("function");
      const b = Lif.computeStepBudget(3, 10);
      expect(b.phase).toBe("ramp_up");
    });

    it("StepBudget 类型导出（编译期检查）", () => {
      // 类型导出无法运行时检查，但导入不报错即说明导出存在
      const b: Lif.StepBudget = Lif.computeStepBudget(1, 5);
      expect(b.total).toBe(5);
    });
  });

  describe("R5 轨迹压缩", () => {
    it("DefaultTraceCompressor 类已导出", () => {
      expect(typeof Lif.DefaultTraceCompressor).toBe("function");
      const c = new Lif.DefaultTraceCompressor();
      expect(c.compress([], "").traceDigest).toBe("");
    });

    it("TraceCompressor 类型导出（编译期检查）", () => {
      const c: Lif.TraceCompressor = new Lif.DefaultTraceCompressor();
      expect(typeof c.compress).toBe("function");
    });

    it("loadPreviousContext 已导出", () => {
      expect(typeof Lif.loadPreviousContext).toBe("function");
    });
  });

  describe("R3 extension 预设", () => {
    it("EXTENSION_PRESETS 注册表已导出", () => {
      expect(Lif.EXTENSION_PRESETS).toBeDefined();
      expect(Lif.EXTENSION_PRESETS.artifacts?.aliases).toContain("nexus_artifacts");
    });

    it("payload helper 已导出", () => {
      expect(typeof Lif.preconditionUnmetPayload).toBe("function");
      expect(typeof Lif.artifactsPayload).toBe("function");
      expect(typeof Lif.reactResultPayload).toBe("function");
      expect(typeof Lif.stepTracePayload).toBe("function");
    });

    it("resolveExtensionAlias 已导出", () => {
      expect(typeof Lif.resolveExtensionAlias).toBe("function");
      expect(Lif.resolveExtensionAlias("nexus_artifacts")).toBe("artifacts");
      expect(Lif.resolveExtensionAlias("react_step_trace")).toBe("step_trace");
      expect(Lif.resolveExtensionAlias("custom_xxx")).toBe("custom_xxx");
    });

    it("isPresetExtension 已导出", () => {
      expect(Lif.isPresetExtension("artifacts")).toBe(true);
      expect(Lif.isPresetExtension("nexus_artifacts")).toBe(true);
      expect(Lif.isPresetExtension("custom")).toBe(false);
    });

    it("类型化 data 接口导出（编译期检查）", () => {
      // meso 2.2.0 要求 ArtifactItem.id 必填
      const item: Lif.ArtifactItem = { id: "r1", type: "html", title: "报告" };
      expect(item.title).toBe("报告");
    });
  });

  describe("既有导出保持不变（回归保障）", () => {
    it("Harness 相关导出仍在", () => {
      expect(typeof Lif.runReactHarness).toBe("function");
      expect(typeof Lif.PreconditionRegistry).toBe("function");
      expect(typeof Lif.GovernanceChain).toBe("function");
    });

    it("Stream event helper 仍在", () => {
      expect(typeof Lif.confirmGatePayload).toBe("function");
      expect(typeof Lif.makeEvent).toBe("function");
    });
  });
});
