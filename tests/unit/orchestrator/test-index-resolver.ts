/**
 * IndexToolResolver 单测（Phase 0.12）。
 *
 * 验证：
 *   - 索引命中（source="index"，confidence=1.0）
 *   - 未命中返回 null
 *   - primary 优先
 *   - 文件不存在降级
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexToolResolver } from "../../../src/orchestrator/index-resolver.js";
import type { SemanticNeed, BizContext } from "../../../src/orchestrator/types.js";

let tmpDir: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "idx-resolver-"));
  indexPath = join(tmpDir, "tool-semantic-index.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeIndex(entries: unknown[]): void {
  writeFileSync(indexPath, JSON.stringify({ version: "1.0", enterprise: "test", entries }, null, 2), "utf8");
}

const ctx: BizContext = { scenarioId: "anomaly", line: "L01" };

describe("IndexToolResolver", () => {
  it("命中返回 source=index, confidence=1.0", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", paramMap: {}, primary: true },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("quality.cp_cpk");
    expect(result!.source).toBe("index");
    expect(result!.confidence).toBe(1.0);
  });

  it("未命中返回 null", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "nonexistent_semantic", required: false };
    const result = await resolver.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("primary 优先（同 semantic 多工具）", async () => {
    writeIndex([
      { semantic: "defect_rate", toolName: "quality.defect_rate" },
      { semantic: "defect_rate", toolName: "quality.fpy", primary: true },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "defect_rate", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result!.toolName).toBe("quality.fpy");
  });

  it("无 primary 时取第一个", async () => {
    writeIndex([
      { semantic: "defect_rate", toolName: "quality.defect_rate" },
      { semantic: "defect_rate", toolName: "quality.fpy" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "defect_rate", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result!.toolName).toBe("quality.defect_rate");
  });

  it("fieldMap 透传", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "mes.capability", fieldMap: { Cpk: "cpk" } },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result!.fieldMap).toEqual({ Cpk: "cpk" });
  });

  it("resolveBatch 过滤 null", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk" },
      { semantic: "defect_rate", toolName: "quality.defect_rate" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const needs: SemanticNeed[] = [
      { semantic: "process_capability", required: true },
      { semantic: "defect_rate", required: true },
      { semantic: "nonexistent", required: false },
    ];
    const results = await resolver.resolveBatch(needs, ctx);
    expect(results.length).toBe(2);
  });

  it("文件不存在降级为空（不抛错）", async () => {
    const resolver = new IndexToolResolver(join(tmpDir, "nonexistent.json"));
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("reload() 重载索引文件（运行时刷新场景）", async () => {
    // 初始：只有 process_capability
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", primary: true },
    ]);
    const resolver = new IndexToolResolver(indexPath);

    // 此时 defect_rate 还没登记
    const need1: SemanticNeed = { semantic: "defect_rate", required: true };
    expect(await resolver.resolve(need1, ctx)).toBeNull();

    // 模拟 catalog 定时刷新重写了 tool-index.json（新增 defect_rate 条目）
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", primary: true },
      { semantic: "defect_rate", toolName: "quality.fpy", primary: true },
    ]);

    // reload 之前内存仍是旧的（defect_rate 仍 miss）
    expect(await resolver.resolve(need1, ctx)).toBeNull();

    // reload 后内存同步到磁盘最新（defect_rate 命中）
    resolver.reload();
    const result = await resolver.resolve(need1, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("quality.fpy");
    expect(result!.source).toBe("index");
  });

  // ── confidence 字段：写入方自定 / 缺省按来源感知 ──

  it("人工 entry（无 source/confidence）缺省 confidence=1.0", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
  });

  it("source=manual 显式标注 → confidence=1.0", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", source: "manual" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
  });

  it("source=derived_catalog → confidence=0.9", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", source: "derived_catalog" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("source=derived_local → confidence=0.9", async () => {
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", source: "derived_local" },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("写入方显式 confidence 优先于 source 推断", async () => {
    // source=derived_catalog 本应 0.9，但写入方显式写 0.75 应胜出
    writeIndex([
      { semantic: "process_capability", toolName: "quality.cp_cpk", source: "derived_catalog", confidence: 0.75 },
    ]);
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.75);
  });

  it("tools 数组格式（格式②反推）标 source=derived_local, confidence=0.9", async () => {
    // 模拟 syncToolIndex 写出的 tools 数组 + semanticTags 格式
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: "1.0",
        enterprise: "test",
        tools: [
          { name: "quality.cp_cpk", semanticTags: ["process_capability"] },
        ],
      }),
      "utf8",
    );
    const resolver = new IndexToolResolver(indexPath);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    // 反推的 entry 应标 derived_local，confidence=0.9（非人工精确登记）
    expect(result!.confidence).toBe(0.9);
  });
});
