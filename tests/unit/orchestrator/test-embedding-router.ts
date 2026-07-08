/**
 * EmbeddingToolRouter 单元测试（Phase M2）。
 *
 * 验证（07-mestar-integration-spec.md §6）：
 *   - 向量索引构建 + 持久化 + 加载
 *   - retrieve top-K 命中预期工具
 *   - resolve 高相似度直接返回（source=index）
 *   - resolve 低相似度返回 null（交下游 LLM）
 *   - Embedder 失败降级（ready=false）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddingToolRouter,
  type Embedder,
} from "../../../src/orchestrator/embedding-router.js";
import type { BucketItem } from "../../../src/tools/mcp/mcp-catalog-cache.js";
import type { SemanticNeed, BizContext } from "../../../src/orchestrator/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "embed-router-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ctx: BizContext = { scenarioId: "anomaly", line: "L01" };

/** 构造确定性 mock Embedder（按文本哈希生成稳定向量，相似文本产生相似向量）。 */
function makeMockEmbedder(): Embedder {
  return {
    embed: vi.fn(async (texts: string[]): Promise<number[][]> => {
      return texts.map((text) => mockTextToVector(text));
    }),
  };
}

/** 把文本转成 8 维 mock 向量（基于关键词，让"设备BOM"查询命中"设备BOM"工具）。 */
function mockTextToVector(text: string): number[] {
  const keywords = ["设备", "bom", "product", "项目", "unit", "quality", "defect", "material"];
  const lower = text.toLowerCase();
  return keywords.map((kw) => (lower.includes(kw) ? 1 : 0));
}

function makeBucket(overrides: Partial<BucketItem> = {}): BucketItem {
  return {
    name: "mestar.query.uempEquipBomView...platform.select",
    title: "设备BOM",
    desc: "platformController platform#select",
    triggers: ["设备BOM", "设备清单"],
    risk: "readOnly",
    ...overrides,
  };
}

describe("EmbeddingToolRouter", () => {
  it("buildIndex 构建向量索引并持久化", async () => {
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });

    await router.buildIndex([makeBucket()]);

    expect(router.isReady()).toBe(true);
    expect(router.indexSize()).toBe(1);
    expect(existsSync(join(tmpDir, "vectors.json"))).toBe(true);
  });

  it("retrieve top-K 按相似度排序", async () => {
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });

    await router.buildIndex([
      makeBucket(), // 设备BOM（与查询"设备BOM查询"高度相似）
      makeBucket({
        name: "mestar.query.xmjbda_1...select",
        title: "项目基本档案",
        desc: "platformController",
        triggers: ["项目基本档案"],
      }), // 项目档案（与查询相似度低）
    ]);

    const candidates = await router.retrieve("设备BOM 查询");
    expect(candidates).toHaveLength(2);
    // 设备BOM 应该排第一（关键词命中更多）
    expect(candidates[0]!.name).toContain("uempEquipBom");
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
  });

  it("resolve 高相似度直接返回 source=index", async () => {
    const embedder = makeMockEmbedder();
    // 降低阈值便于 mock 向量触发
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder, directHitThreshold: 0.5 });
    await router.buildIndex([makeBucket()]);

    const need: SemanticNeed = { semantic: "device_bom", required: true };
    const result = await router.resolve(need, ctx);

    expect(result).not.toBeNull();
    expect(result!.toolName).toContain("uempEquipBom");
    expect(result!.source).toBe("index");
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it("resolve 低相似度返回 null（交下游 LLM）", async () => {
    const embedder = makeMockEmbedder();
    // 高阈值让 mock 向量达不到
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder, directHitThreshold: 0.99 });
    await router.buildIndex([makeBucket()]);

    const need: SemanticNeed = { semantic: "unknown_thing", required: true };
    const result = await router.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("未构建索引时 retrieve 返回空数组", async () => {
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });
    const candidates = await router.retrieve("anything");
    expect(candidates).toEqual([]);
  });

  it("loadIndex 从持久化文件恢复", async () => {
    const embedder = makeMockEmbedder();
    // 第一次：构建并持久化
    const router1 = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });
    await router1.buildIndex([makeBucket()]);
    expect(router1.isReady()).toBe(true);

    // 第二次：新实例从文件加载（不调 embedder）
    const embedder2 = makeMockEmbedder();
    const router2 = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder: embedder2 });
    const loaded = router2.loadIndex();
    expect(loaded).toBe(true);
    expect(router2.isReady()).toBe(true);
    expect(router2.indexSize()).toBe(1);
    // embedder2 不应被调用（走了缓存）
    expect(embedder2.embed).not.toHaveBeenCalled();
  });

  it("Embedder 失败 → 降级 ready=false", async () => {
    const failingEmbedder: Embedder = {
      embed: vi.fn(async () => {
        throw new Error("embedding service unavailable");
      }),
    };
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder: failingEmbedder });
    await router.buildIndex([makeBucket()]);
    expect(router.isReady()).toBe(false);

    // 未就绪时 resolve 返回 null
    const need: SemanticNeed = { semantic: "device_bom", required: true };
    const result = await router.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("空 buckets → ready=false", async () => {
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });
    await router.buildIndex([]);
    expect(router.isReady()).toBe(false);
  });

  it("reload() 注入 bucketProvider 时重建向量索引", async () => {
    // 模拟 catalog 刷新：bucketProvider 第一次返回 1 个工具，第二次返回 2 个
    let bucketCount = 1;
    const bucketProvider = () => {
      const base = [makeBucket()];
      if (bucketCount >= 2) {
        base.push(
          makeBucket({
            name: "mestar.query.xmjbda_1...select",
            title: "项目档案",
            desc: "项目基本档案查询",
            triggers: ["项目档案"],
          }),
        );
      }
      return base;
    };
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder, bucketProvider });

    // 初始构建：1 个工具
    await router.buildIndex(bucketProvider());
    expect(router.indexSize()).toBe(1);

    // 模拟 catalog 刷新：bucketProvider 返回值变化
    bucketCount = 2;
    // reload() 异步触发 buildIndex（不 await），等待微任务跑完
    router.reload();
    await new Promise((r) => setTimeout(r, 50));

    expect(router.indexSize()).toBe(2);
    expect(embedder.embed).toHaveBeenCalledTimes(2); // 初始 + reload 各一次
  });

  it("reload() 未注入 bucketProvider 时降级为 loadIndex", async () => {
    const embedder = makeMockEmbedder();
    // 第一个 router 构建并持久化
    const router1 = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder });
    await router1.buildIndex([makeBucket()]);

    // 第二个 router：不注入 bucketProvider，只 loadIndex
    const embedder2 = makeMockEmbedder();
    const router2 = new EmbeddingToolRouter({ cacheDir: tmpDir, embedder: embedder2 });
    expect(router2.loadIndex()).toBe(true);
    expect(router2.indexSize()).toBe(1);

    // reload 应回退到 loadIndex（不调 embedder）
    router2.reload();
    expect(router2.isReady()).toBe(true);
    expect(embedder2.embed).not.toHaveBeenCalled();
  });
});
