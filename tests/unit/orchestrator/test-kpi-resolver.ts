/**
 * KpiResolver 单元测试（L1.3）。
 *
 * 验证：
 *   - 非 KPI 类需求 → 返回 null（让后续 resolver 处理）
 *   - KPI 可计算 → 返回 null（让后续 resolver 找具体工具）
 *   - KPI 不可计算 → 产出 composite（kind=kpi_unavailable）
 *   - KPI 部分可算 → 产出 composite（kind=kpi_partial）
 *   - KpiCatalogCache 未就绪 → 跳过
 *   - kpi.assess 调用失败 → 跳过（降级）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KpiCatalogCache, type KpiDescriptor } from "../../../src/tools/mcp/kpi-catalog-cache.js";
import { KpiResolver } from "../../../src/orchestrator/kpi-resolver.js";
import type { McpClient, McpToolCallResult } from "../../../src/tools/mcp/mcp-client.js";
import type { BizContext, SemanticNeed } from "../../../src/orchestrator/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kpi-resolver-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造 mock McpClient，按 tool 名分流 kpi.search/assess/guide 返回。 */
function makeMockClient(opts: {
  kpis?: KpiDescriptor[];
  assessResult?: { calculable: boolean; available?: string[]; missing?: Array<{ field: string; reason?: string }>; summary?: string };
  guideResult?: { guide?: string; alternatives?: string[] };
  assessThrows?: boolean;
}): McpClient {
  return {
    callTool: vi.fn(async (name: string): Promise<McpToolCallResult> => {
      if (name === "mestar.kpi.search") {
        return {
          content: [{ type: "text", text: JSON.stringify({ kpis: opts.kpis ?? [] }) }],
          structuredContent: { kpis: opts.kpis ?? [] },
        } as McpToolCallResult;
      }
      if (name === "mestar.kpi.assess") {
        if (opts.assessThrows) throw new Error("assess 调用失败");
        const result = opts.assessResult ?? { calculable: false };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        } as McpToolCallResult;
      }
      if (name === "mestar.kpi.guide") {
        const result = opts.guideResult ?? {};
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        } as McpToolCallResult;
      }
      throw new Error(`未 mock 的工具调用：${name}`);
    }),
  } as unknown as McpClient;
}

const ctx: BizContext = { scenarioId: undefined, line: undefined };

/** 构造 SemanticNeed。 */
function need(semantic: string): SemanticNeed {
  return { semantic, required: true };
}

describe("KpiResolver.resolve", () => {
  it("非 KPI 类需求 → 返回 null（让后续 resolver 处理）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率" }],
      assessResult: { calculable: false },
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    // semantic="device_bom" 不在 KPI 目录里
    const result = await resolver.resolve(need("device_bom"), ctx);
    expect(result).toBeNull();
  });

  it("KPI 可计算 → 返回 null（让后续 resolver 找具体工具）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率" }],
      assessResult: { calculable: true, available: ["设备停机时长", "计划工时", "合格品数"] },
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    const result = await resolver.resolve(need("oee"), ctx);
    expect(result).toBeNull(); // 可计算，交给后续工具级 resolver
  });

  it("KPI 不可计算 → 产出 composite（kind=kpi_unavailable）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率", aliases: ["OEE"] }],
      assessResult: {
        calculable: false,
        missing: [
          { field: "设备停机时长", reason: "MES 未接入" },
          { field: "标准工时", reason: "需要人工录入" },
        ],
        summary: "缺关键数据维度，无法精确计算",
      },
      guideResult: {
        guide: "可用设备稼动率近似估算",
        alternatives: ["用设备稼动率近似估算", "采集 1 周数据后重算"],
      },
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    const result = await resolver.resolve(need("oee"), ctx);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("kpi");
    expect(result!.confidence).toBeGreaterThan(0.8);
    expect(result!.composite).toBeDefined();
    expect(result!.composite!.kind).toBe("kpi_unavailable");
    expect(result!.composite!.kpi).toBe("oee");
    expect(result!.composite!.kpiLabel).toBe("设备综合效率");
    expect(result!.composite!.missingDimensions).toHaveLength(2);
    expect(result!.composite!.missingDimensions![0]!.field).toBe("设备停机时长");
    expect(result!.composite!.guidance).toContain("设备综合效率");
    expect(result!.composite!.guidance).toContain("无法精确计算");
    expect(result!.composite!.calculationGuide).toBe("可用设备稼动率近似估算");
    expect(result!.composite!.alternatives).toEqual(["用设备稼动率近似估算", "采集 1 周数据后重算"]);
  });

  it("KPI 部分可算 → 产出 composite（kind=kpi_partial）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率" }],
      assessResult: {
        calculable: false,
        available: ["计划工时", "合格品数"],
        missing: [{ field: "设备停机时长" }],
      },
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    const result = await resolver.resolve(need("oee"), ctx);
    expect(result).not.toBeNull();
    expect(result!.composite!.kind).toBe("kpi_partial");
    expect(result!.composite!.availableDimensions).toEqual(["计划工时", "合格品数"]);
    expect(result!.composite!.missingDimensions).toHaveLength(1);
  });

  it("kpi.assess 调用失败 → 返回 null（降级让后续 resolver 处理）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率" }],
      assessThrows: true,
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    const result = await resolver.resolve(need("oee"), ctx);
    expect(result).toBeNull();
  });

  it("KpiCatalogCache 未就绪 → 返回 null", async () => {
    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client: failingClient, cacheRoot: tmpDir });
    await kpiCatalog.warmup(); // 未就绪
    const resolver = new KpiResolver({ client: failingClient, kpiCatalog });

    const result = await resolver.resolve(need("oee"), ctx);
    expect(result).toBeNull();
  });

  it("按别名匹配 KPI（如 OEE 大写）", async () => {
    const client = makeMockClient({
      kpis: [{ id: "oee", label: "设备综合效率", aliases: ["OEE", "稼动率综合"] }],
      assessResult: { calculable: false, missing: [{ field: "设备停机时长" }] },
    });
    const kpiCatalog = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await kpiCatalog.warmup();
    const resolver = new KpiResolver({ client, kpiCatalog });

    // 用别名触发
    const result = await resolver.resolve(need("稼动率综合"), ctx);
    expect(result).not.toBeNull();
    expect(result!.composite!.kpi).toBe("oee");
  });
});
