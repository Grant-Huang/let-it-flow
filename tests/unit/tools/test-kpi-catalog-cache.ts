/**
 * KpiCatalogCache 单元测试（L1.2）。
 *
 * 验证：
 *   - kpi.search 预热（mock mestar.kpi.search）
 *   - findBySemantic 多形态匹配（id / 别名 / 中文 label 包含）
 *   - getPromptCatalog 渲染 systemPrompt 文本
 *   - 预热失败降级（不阻塞）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KpiCatalogCache, type KpiDescriptor } from "../../../src/tools/mcp/kpi-catalog-cache.js";
import type { McpClient, McpToolCallResult } from "../../../src/tools/mcp/mcp-client.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kpi-catalog-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造 mock McpClient，模拟 mestar.kpi.search 返回。 */
function makeMockClient(kpis: KpiDescriptor[]): McpClient {
  return {
    callTool: vi.fn(async (name: string): Promise<McpToolCallResult> => {
      if (name === "mestar.kpi.search") {
        return {
          content: [{ type: "text", text: JSON.stringify({ kpis }) }],
          structuredContent: { kpis },
        } as McpToolCallResult;
      }
      throw new Error(`未 mock 的工具调用：${name}`);
    }),
  } as unknown as McpClient;
}

/** 构造典型 KPI 描述符。 */
function makeKpi(overrides: Partial<KpiDescriptor> = {}): KpiDescriptor {
  return {
    id: "oee",
    label: "设备综合效率",
    domain: "Equipment",
    requiredDimensions: ["设备停机时长", "计划工时", "合格品数"],
    aliases: ["OEE", "设备效率", "稼动率综合"],
    description: "衡量设备综合效率的核心指标",
    formula: "OEE = 可用率 × 性能率 × 良率",
    unit: "%",
    ...overrides,
  };
}

describe("KpiCatalogCache.warmup", () => {
  it("kpi.search 预热 + 内存索引构建", async () => {
    const kpis = [
      makeKpi(),
      makeKpi({ id: "fpy", label: "一次合格率", domain: "Quality" }),
    ];
    const client = makeMockClient(kpis);
    const cache = new KpiCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
    });

    await cache.warmup();

    expect(cache.isReady()).toBe(true);
    expect(cache.getKpis()).toHaveLength(2);
  });

  it("kpi.search 不可达 → ready=false 不抛错", async () => {
    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;

    const cache = new KpiCatalogCache({
      serverId: "mestar",
      client: failingClient,
      cacheRoot: tmpDir,
    });

    await cache.warmup();
    expect(cache.isReady()).toBe(false);
    expect(cache.getKpis()).toHaveLength(0);
  });
});

describe("KpiCatalogCache.findBySemantic（多形态匹配）", () => {
  beforeEach(async () => {
    // 预热缓存
  });

  it("按 id 精确匹配（大小写不敏感）", async () => {
    const client = makeMockClient([makeKpi()]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    expect(cache.findBySemantic("oee")?.id).toBe("oee");
    expect(cache.findBySemantic("OEE")?.id).toBe("oee");
    expect(cache.findBySemantic("Oee")?.id).toBe("oee");
  });

  it("按别名精确匹配", async () => {
    const client = makeMockClient([makeKpi()]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    expect(cache.findBySemantic("稼动率综合")?.id).toBe("oee");
  });

  it("按中文 label 包含匹配", async () => {
    const client = makeMockClient([makeKpi()]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    // 完整 label
    expect(cache.findBySemantic("设备综合效率")?.id).toBe("oee");
    // 部分包含
    expect(cache.findBySemantic("综合效率")?.id).toBe("oee");
  });

  it("不存在的语义 → 返回 undefined", async () => {
    const client = makeMockClient([makeKpi()]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    expect(cache.findBySemantic("nonexistent_kpi")).toBeUndefined();
  });
});

describe("KpiCatalogCache.getPromptCatalog", () => {
  it("渲染 KPI 目录文本（含公式 + 需要维度）", async () => {
    const client = makeMockClient([
      makeKpi(),
      makeKpi({ id: "fpy", label: "一次合格率", formula: "FPY = 合格品数 / 总加工数", requiredDimensions: ["合格品数", "总加工数"] }),
    ]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    const text = cache.getPromptCatalog();
    expect(text).toContain("oee");
    expect(text).toContain("设备综合效率");
    expect(text).toContain("OEE = 可用率 × 性能率 × 良率");
    expect(text).toContain("设备停机时长");
    expect(text).toContain("fpy");
    expect(text).toContain("一次合格率");
  });

  it("无 KPI → 返回空字符串", async () => {
    const client = makeMockClient([]);
    const cache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpDir });
    await cache.warmup();

    expect(cache.getPromptCatalog()).toBe("");
  });
});
