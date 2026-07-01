/**
 * 证据源地图动态生成器单测。
 *
 * 验证 buildEvidenceMap 的核心行为：
 *   - 按 domain 前缀自动分组
 *   - "第一取证点"工具排前并标记
 *   - evidenceMeta 缺失时降级（不显示标签）
 *   - 空 registry 返回空字符串
 *   - 完整 buildNexusTools 产出的地图含全部域
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { buildEvidenceMap } from "../../../../apps/nexusops/tools/evidence-map.js";
import type { FlowConnector } from "../../../../src/tools/base.js";

/** 构造最小 FlowConnector（仅填充 evidence-map 需要的字段）。 */
function makeTool(
  name: string,
  description: string,
  triggers: string[] = [],
  evidenceMeta?: { confidence?: "measured" | "estimated" | "inferred"; freshness?: string },
): FlowConnector {
  return {
    name,
    tier: "domain",
    description,
    inputSchema: { type: "object", properties: {} },
    whenToUse: { triggers, notFor: [] },
    outputSchema: { type: "object", properties: {} },
    outputExample: {},
    // eslint-disable-next-line require-yield
    async *execute() {
      return { output: {} };
    },
    ...(evidenceMeta ? { evidenceMeta } : {}),
  } as unknown as FlowConnector;
}

function registryOf(...tools: FlowConnector[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分组与格式
// ─────────────────────────────────────────────────────────────────────────────

describe("buildEvidenceMap 分组与格式", () => {
  it("空 registry 返回空字符串", () => {
    expect(buildEvidenceMap(new ToolRegistry())).toBe("");
  });

  it("按前缀自动分组", () => {
    const reg = registryOf(
      makeTool("oee.realtime", "实时 OEE"),
      makeTool("oee.history", "历史趋势"),
      makeTool("equipment.status", "设备状态"),
    );
    const map = buildEvidenceMap(reg);
    expect(map).toContain("### oee 域");
    expect(map).toContain("### equipment 域");
    // oee 组含两个工具
    const oeeSection = map.split("### equipment")[0];
    expect(oeeSection).toContain("oee.realtime");
    expect(oeeSection).toContain("oee.history");
  });

  it("evidenceMeta 存在时显示 [confidence/freshness] 标签", () => {
    const reg = registryOf(
      makeTool("oee.realtime", "实时 OEE", [], {
        confidence: "measured",
        freshness: "realtime",
      }),
    );
    const map = buildEvidenceMap(reg);
    expect(map).toContain("[measured/realtime]");
  });

  it("evidenceMeta 缺失时不显示标签（降级）", () => {
    const reg = registryOf(makeTool("oee.realtime", "实时 OEE"));
    const map = buildEvidenceMap(reg);
    expect(map).not.toContain("[");
    expect(map).toContain("oee.realtime");
  });

  it("description 超长时截断（含省略号）", () => {
    const longDesc = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常长的描述".repeat(3);
    const reg = registryOf(makeTool("oee.test", longDesc));
    const map = buildEvidenceMap(reg);
    expect(map).toContain("…");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 第一取证点排序与标记
// ─────────────────────────────────────────────────────────────────────────────

describe("buildEvidenceMap 第一取证点", () => {
  it("description 含'第一取证点'的排前并标记", () => {
    const reg = registryOf(
      makeTool("oee.history", "历史趋势"),
      makeTool("oee.realtime", "实时 OEE，诊断效率问题的第一取证点"),
    );
    const map = buildEvidenceMap(reg);
    const oeeSection = map.split("### oee 域")[1] ?? "";
    const realtimeIdx = oeeSection.indexOf("oee.realtime");
    const historyIdx = oeeSection.indexOf("oee.history");
    expect(realtimeIdx).toBeLessThan(historyIdx);
    expect(oeeSection).toContain("[第一取证点]");
  });

  it("triggers 含'首选'也触发标记", () => {
    const reg = registryOf(
      makeTool("process.adjustment", "参数回调", ["首选可执行动作"]),
    );
    const map = buildEvidenceMap(reg);
    expect(map).toContain("[第一取证点]");
  });

  it("无第一取证点的组不出现标记", () => {
    const reg = registryOf(
      makeTool("oee.history", "历史趋势"),
      makeTool("oee.compare", "产线对比"),
    );
    const map = buildEvidenceMap(reg);
    expect(map).not.toContain("[第一取证点]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 完整工具集集成
// ─────────────────────────────────────────────────────────────────────────────

describe("buildEvidenceMap 完整工具集集成", () => {
  it("从 buildNexusTools 产出的 registry 生成含全部域的地图", () => {
    const reg = new ToolRegistry();
    for (const connector of buildNexusTools()) {
      if (!reg.has(connector.name)) reg.register(connector);
    }
    const map = buildEvidenceMap(reg);

    // 标题存在
    expect(map).toContain("## 证据源地图");
    // 全部 8 个 domain 前缀都出现
    for (const prefix of [
      "oee",
      "equipment",
      "quality",
      "process",
      "energy",
      "schedule",
      "material",
      "personnel",
    ]) {
      expect(map).toContain(`### ${prefix} 域`);
    }
    // oee.realtime 是第一取证点（description 含"第一取证点"）
    expect(map).toContain("oee.realtime");
    expect(map).toContain("[第一取证点]");
    // confidence 标签出现（createQueryTool 填充了 evidenceMeta）
    expect(map).toContain("[measured/realtime]");
  });
});
