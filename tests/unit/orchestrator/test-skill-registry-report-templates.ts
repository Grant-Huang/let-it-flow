/**
 * SkillRegistry reportTemplates 单测（Phase 0.12）。
 *
 * 验证：
 *   - registerReportTemplate 登记成功
 *   - getReportTemplate 按 reportType 查找 active 模板
 *   - activeReportTemplates 列出所有 active
 *   - draft 模板不被 getReportTemplate 返回
 *   - 持久化 load/save 往返
 *   - deleteReportTemplate
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../../src/agent/skill-registry.js";
import type { ComponentLayout } from "../../../src/orchestrator/report-types.js";

let dataDir: string;
let filePath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "skill-reg-rt-"));
  filePath = join(dataDir, "skills.json");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeLayout(reportType: string): ComponentLayout {
  return {
    reportType,
    title: `${reportType} 报告`,
    meta: { line: "L01" },
    components: [
      { name: "kpi-card", data: { label: "测试", value: "1.0" } },
    ],
  };
}

describe("SkillRegistry reportTemplates", () => {
  it("registerReportTemplate 登记成功", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({
      reportType: "dmaic",
      title: "DMAIC 报告",
      layout: makeLayout("dmaic"),
      status: "active",
      source: "manual",
    });
    const t = reg.getReportTemplate("dmaic");
    expect(t).toBeDefined();
    expect(t!.reportType).toBe("dmaic");
    expect(t!.status).toBe("active");
    expect(t!.createdAt).toBeDefined();
    expect(t!.updatedAt).toBeDefined();
  });

  it("getReportTemplate 只返回 active（draft 不返回）", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({
      reportType: "draft_report",
      title: "草稿",
      layout: makeLayout("draft_report"),
      status: "draft",
      source: "manual",
    });
    expect(reg.getReportTemplate("draft_report")).toBeUndefined();
  });

  it("activeReportTemplates 只列 active", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({ reportType: "active1", title: "1", layout: makeLayout("active1"), status: "active", source: "manual" });
    reg.registerReportTemplate({ reportType: "active2", title: "2", layout: makeLayout("active2"), status: "active", source: "manual" });
    reg.registerReportTemplate({ reportType: "draft1", title: "3", layout: makeLayout("draft1"), status: "draft", source: "manual" });
    const active = reg.activeReportTemplates();
    expect(active.length).toBe(2);
    const types = active.map((t) => t.reportType);
    expect(types).toContain("active1");
    expect(types).toContain("active2");
    expect(types).not.toContain("draft1");
  });

  it("同 reportType 覆盖（保留 createdAt）", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({ reportType: "energy", title: "v1", layout: makeLayout("energy"), status: "active", source: "manual" });
    const firstCreatedAt = reg.getReportTemplate("energy")!.createdAt;
    // 等 1ms 确保 updatedAt 不同
    reg.registerReportTemplate({ reportType: "energy", title: "v2", layout: makeLayout("energy"), status: "active", source: "manual" });
    const t = reg.getReportTemplate("energy");
    expect(t!.title).toBe("v2");
    expect(t!.createdAt).toBe(firstCreatedAt); // createdAt 保留
  });

  it("持久化 load/save 往返", () => {
    const reg1 = new SkillRegistry(filePath);
    reg1.registerReportTemplate({ reportType: "dmaic", title: "DMAIC", layout: makeLayout("dmaic"), status: "active", source: "manual" });
    // 新实例从同一文件加载
    const reg2 = new SkillRegistry(filePath);
    const t = reg2.getReportTemplate("dmaic");
    expect(t).toBeDefined();
    expect(t!.title).toBe("DMAIC");
    expect(t!.layout.components.length).toBe(1);
  });

  it("deleteReportTemplate 删除", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({ reportType: "to_delete", title: "x", layout: makeLayout("to_delete"), status: "active", source: "manual" });
    expect(reg.getReportTemplate("to_delete")).toBeDefined();
    reg.deleteReportTemplate("to_delete");
    expect(reg.getReportTemplate("to_delete")).toBeUndefined();
  });

  it("reportTemplates 与 candidates/skills 共存于同一文件", () => {
    const reg = new SkillRegistry(filePath);
    reg.registerReportTemplate({ reportType: "oee", title: "OEE", layout: makeLayout("oee"), status: "active", source: "manual" });
    // 验证文件结构含三张表
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.candidates).toBeDefined();
    expect(raw.skills).toBeDefined();
    expect(raw.reportTemplates).toBeDefined();
    expect(raw.reportTemplates.length).toBe(1);
  });
});
