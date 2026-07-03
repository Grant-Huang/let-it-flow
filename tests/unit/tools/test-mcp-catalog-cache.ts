/**
 * McpCatalogCache 单元测试（Phase M1）。
 *
 * 验证（07-mestar-integration-spec.md §5）：
 *   - 分页拉取 catalog（mock mestar.catalog.search）
 *   - 规则派生 semanticTags（module/menu/method → semantic）
 *   - executable=false 的工具不进语义索引/分桶
 *   - 模块地图生成正确
 *   - 预热失败不阻塞（降级到无缓存）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpCatalogCache, deriveSemantic, type CatalogItem } from "../../../src/tools/mcp/mcp-catalog-cache.js";
import type { McpClient, McpToolCallResult } from "../../../src/tools/mcp/mcp-client.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造 mock McpClient，模拟 mestar.catalog.search 分页返回。 */
function makeMockClient(pages: CatalogItem[][]): McpClient {
  let callIdx = 0;
  return {
    callTool: vi.fn(async (_name: string, args: { limit?: number; cursor?: string }): Promise<McpToolCallResult> => {
      const page = pages[Math.min(callIdx, pages.length - 1)] ?? [];
      callIdx++;
      const nextCursor = callIdx < pages.length ? String(callIdx * (args.limit ?? 200)) : undefined;
      const total = pages.reduce((sum, p) => sum + p.length, 0);
      return {
        content: [{ type: "text", text: JSON.stringify({ items: page, total, nextCursor }) }],
        structuredContent: { items: page, total, nextCursor },
      } as McpToolCallResult;
    }),
  } as unknown as McpClient;
}

/** 构造典型 catalog item（设备BOM 查询，可执行只读）。 */
function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    name: "mestar.query.uempEquipBomView_FORM_Tree.uempEquipBomform.platform.select",
    title: "设备BOM",
    description: "platformController platform#select",
    kind: "platformController",
    risk: "readOnly",
    executable: true,
    route: { adapter: "platformController", bean: "platform", method: "select", entity: "com.epichust.entity.UempEquipBom" },
    menu: { name: "设备BOM", rel: "uempEquipBomView_FORM_Tree" },
    module: { name: "Uemp", source: "entityPrefix" },
    ...overrides,
  };
}

describe("deriveSemantic（规则派生）", () => {
  it("executable + readOnly + 已知 module/menu → 派生 semantic", () => {
    const item = makeItem();
    const tags = deriveSemantic(item);
    expect(tags).toEqual(["device_bom_query"]);
  });

  it("executable=false → 不派生（返回空）", () => {
    const item = makeItem({ executable: false });
    expect(deriveSemantic(item)).toEqual([]);
  });

  it("risk=businessCritical → 不派生", () => {
    const item = makeItem({ risk: "businessCritical" });
    expect(deriveSemantic(item)).toEqual([]);
  });

  it("未知 module → 不派生", () => {
    const item = makeItem({ module: { name: "UnknownModule", source: "x" } });
    expect(deriveSemantic(item)).toEqual([]);
  });

  it("Mbb module + 项目基本档案 → product_unit_query", () => {
    const item = makeItem({
      name: "mestar.query.xmjbda_1.xmjbda_GRID_MbbProductUnit.platform.select",
      title: "项目基本档案",
      menu: { name: "项目基本档案", rel: "xmjbda_1" },
      module: { name: "Mbb", source: "entityPrefix" },
      route: { adapter: "platformController", bean: "platform", method: "select" },
    });
    expect(deriveSemantic(item)).toEqual(["product_unit_query"]);
  });
});

describe("McpCatalogCache.warmup", () => {
  it("分页拉取 + 派生 + 分桶持久化", async () => {
    const items = [
      makeItem(), // Uemp 设备BOM 查询（executable）
      makeItem({
        name: "mestar.business.uempEquipBomView_FORM_Tree.dyna_btn_default_del",
        title: "删除",
        kind: "templateAction",
        risk: "businessCritical",
        executable: false,
        route: { adapter: "templateAction", method: "del" },
      }), // Uemp 删除按钮（不可执行）
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();

    expect(cache.isReady()).toBe(true);

    // 模块地图正确
    const map = cache.getModuleMap();
    expect(map).not.toBeNull();
    expect(map!.totalTools).toBe(2);
    expect(map!.totalExecutable).toBe(1);
    expect(map!.modules).toHaveLength(1);
    expect(map!.modules[0]!.name).toBe("Uemp");
    expect(map!.modules[0]!.executableCount).toBe(1);

    // 分桶只含 executable 工具
    const bucket = cache.getBucket("Uemp");
    expect(bucket).toHaveLength(1);
    expect(bucket[0]!.name).toContain("platform.select");
    expect(bucket[0]!.semanticTags).toEqual(["device_bom_query"]);

    // tool-index.json 追加了派生 semantic 的工具
    const indexRaw = readFileSync(join(tmpDir, "tool-index.json"), "utf8");
    const index = JSON.parse(indexRaw);
    expect(index.tools.some((t: { name: string }) => t.name.includes("platform.select"))).toBe(true);

    // by-module 目录文件存在
    expect(existsSync(join(tmpDir, "mestar", "by-module", "Uemp.json"))).toBe(true);
  });

  it("多模块按 module 分桶", async () => {
    const items = [
      makeItem(), // Uemp
      makeItem({
        name: "mestar.query.xmjbda_1.xmjbda_GRID_MbbProductUnit.platform.select",
        title: "项目基本档案",
        menu: { name: "项目基本档案", rel: "xmjbda_1" },
        module: { name: "Mbb", source: "entityPrefix" },
      }), // Mbb
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();

    const map = cache.getModuleMap();
    expect(map!.modules).toHaveLength(2);
    const moduleNames = map!.modules.map((m) => m.name).sort();
    expect(moduleNames).toEqual(["Mbb", "Uemp"]);

    expect(cache.getBucket("Uemp")).toHaveLength(1);
    expect(cache.getBucket("Mbb")).toHaveLength(1);
  });

  it("mestar 不可达 + 无本地缓存 → ready=false 不抛错", async () => {
    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;

    const cache = new McpCatalogCache({
      serverId: "mestar",
      client: failingClient,
      cacheRoot: tmpDir,
    });

    await cache.warmup();
    expect(cache.isReady()).toBe(false);
    expect(cache.getModuleMap()).toBeNull();
  });

  it("mestar 不可达 + 有过期缓存 → 降级用缓存 ready=true", async () => {
    // 先写一份过期缓存
    const cacheDir = join(tmpDir, "mestar");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cacheDir, "by-module"), { recursive: true });
    const staleMap = {
      serverId: "mestar",
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 天前
      totalTools: 100,
      totalExecutable: 10,
      modules: [{ name: "Uemp", desc: "设备", toolCount: 100, executableCount: 10 }],
    };
    writeFileSync(join(cacheDir, "module-map.json"), JSON.stringify(staleMap));

    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;

    const cache = new McpCatalogCache({
      serverId: "mestar",
      client: failingClient,
      cacheRoot: tmpDir,
    });

    await cache.warmup();
    expect(cache.isReady()).toBe(true); // 降级用过期缓存
    const map = cache.getModuleMap();
    expect(map!.totalTools).toBe(100);
  });

  it("getAllBuckets 汇总全部分桶（供 EmbeddingRouter 用）", async () => {
    const items = [
      makeItem(),
      makeItem({
        name: "mestar.query.xmjbda_1...select",
        title: "项目基本档案",
        menu: { name: "项目基本档案" },
        module: { name: "Mbb", source: "entityPrefix" },
      }),
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();
    const all = cache.getAllBuckets();
    expect(all).toHaveLength(2);
  });
});
