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
});
