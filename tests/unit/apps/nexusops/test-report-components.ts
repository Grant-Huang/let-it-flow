/**
 * Phase 1.4 报表组件库 + 渲染器单元测试。
 *
 * 验证：
 *   - 13 个组件的渲染契约（输入 data → 输出 HTML 片段，含关键字段）
 *   - escapeHtml 防 XSS
 *   - ComponentLayout → 完整 HTML 端到端（DOCTYPE / 标题 / 组件序列 / postMessage 脚本）
 *   - 未知组件降级为 error-box
 *   - 组件清单 getComponentManifest 返回全部组件
 */
import { describe, it, expect } from "vitest";
import {
  REPORT_COMPONENTS,
  REPORT_CSS,
  getComponentManifest,
  escapeHtml,
  pct,
  colorByThreshold,
} from "../../../../apps/nexusops/skills/report-components.js";
import { renderReport } from "../../../../apps/nexusops/skills/report-renderer.js";
import type { ComponentLayout } from "../../../../src/orchestrator/report-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数测试
// ─────────────────────────────────────────────────────────────────────────────

describe("report-components 辅助函数", () => {
  it("escapeHtml 转义 < > & \" '", () => {
    expect(escapeHtml(`<a href="x">'y'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;y&#39;&lt;/a&gt;",
    );
  });

  it("pct 把 0-1 转百分比字符串", () => {
    expect(pct(0.855)).toBe("85.5%");
    expect(pct(1)).toBe("100.0%");
  });

  it("colorByThreshold 按阈值返回绿/黄/红", () => {
    expect(colorByThreshold(0.9, 0.8)).toBe("#22c55e");
    expect(colorByThreshold(0.7, 0.8)).toBe("#f59e0b");
    expect(colorByThreshold(0.5, 0.8)).toBe("#ef4444");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 单组件渲染契约测试
// ─────────────────────────────────────────────────────────────────────────────

describe("单组件渲染契约", () => {
  it("kpi-card 渲染标签 + 数值 + 目标", () => {
    const html = REPORT_COMPONENTS["kpi-card"]!.render({
      label: "综合 OEE",
      value: "85.5%",
      target: "目标 90%",
      color: "#22c55e",
    });
    expect(html).toContain("综合 OEE");
    expect(html).toContain("85.5%");
    expect(html).toContain("目标 90%");
    expect(html).toContain("color:#22c55e");
  });

  it("kpi-grid 包装多个 kpi-card", () => {
    const html = REPORT_COMPONENTS["kpi-grid"]!.render({
      cards: [
        { label: "OEE", value: "85%" },
        { label: "可用率", value: "90%" },
      ],
    });
    expect(html).toContain('class="kpi-grid"');
    expect(html).toContain("OEE");
    expect(html).toContain("可用率");
  });

  it("trend-svg 渲染折线 + 目标线", () => {
    const html = REPORT_COMPONENTS["trend-svg"]!.render({
      points: [80, 82, 85],
      target: 90,
      label: "趋势",
    });
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
    expect(html).toContain("趋势");
  });

  it("trend-svg 空数据降级 error-box", () => {
    const html = REPORT_COMPONENTS["trend-svg"]!.render({ points: [] });
    expect(html).toContain("error-box");
  });

  it("evidence-table 渲染表格 + 行", () => {
    const html = REPORT_COMPONENTS["evidence-table"]!.render({
      rows: [{ tool: "oee.realtime", data: "OEE=85%", step: "基础指标" }],
    });
    expect(html).toContain("<table");
    expect(html).toContain("oee.realtime");
    expect(html).toContain("基础指标");
  });

  it("root-cause-tree 渲染根因 + 层级", () => {
    const html = REPORT_COMPONENTS["root-cause-tree"]!.render({
      rootCause: "刀具磨损",
      layers: ["为什么磨损→参数偏高", "为什么偏高→SOP 未更新"],
    });
    expect(html).toContain("根因：刀具磨损");
    expect(html).toContain("SOP 未更新");
    expect(html).toContain("tree-layer");
  });

  it("fishbone-summary 非空分支渲染，空分支降级", () => {
    const html = REPORT_COMPONENTS["fishbone-summary"]!.render({
      branches: [{ dimension: "人", factors: ["培训不足"] }],
    });
    expect(html).toContain("人");
    expect(html).toContain("培训不足");

    const empty = REPORT_COMPONENTS["fishbone-summary"]!.render({
      branches: [{ dimension: "人", factors: [] }],
    });
    expect(empty).toContain("无显著异常因素");
  });

  it("confidence-bar 渲染百分比 + 颜色", () => {
    const html = REPORT_COMPONENTS["confidence-bar"]!.render({
      label: "置信度",
      value: 0.88,
    });
    expect(html).toContain("置信度");
    expect(html).toContain("88%");
    expect(html).toContain("#22c55e");
  });

  it("recommendation-card 含可执行按钮（postMessage）", () => {
    const html = REPORT_COMPONENTS["recommendation-card"]!.render({
      index: 1,
      title: "回调参数",
      rationale: "Cpk 偏低",
      impact: 0.8,
      executionScore: 0.6,
      actionTool: "mcp.process.adjust_parameters",
      actionArgs: { line: "L01" },
    });
    expect(html).toContain("#1");
    expect(html).toContain("回调参数");
    expect(html).toContain("可执行");
    expect(html).toContain("postMessage");
    expect(html).toContain("mcp.process.adjust_parameters");
  });

  it("recommendation-card 无 actionTool 时不渲染按钮", () => {
    const html = REPORT_COMPONENTS["recommendation-card"]!.render({
      title: "建议",
    });
    expect(html).not.toContain("postMessage");
  });

  it("recommendation-list 空列表降级文案", () => {
    const html = REPORT_COMPONENTS["recommendation-list"]!.render({
      recommendations: [],
      emptyText: "暂无建议",
    });
    expect(html).toContain("暂无建议");
  });

  it("phase-card 渲染阶段标识 + 状态徽章", () => {
    const html = REPORT_COMPONENTS["phase-card"]!.render({
      phase: "D",
      name: "Define（定义）",
      objective: "明确改善课题",
      detailHtml: "<strong>课题：</strong>OEE 偏低",
      status: "ready",
    });
    expect(html).toContain("badge-phase");
    expect(html).toContain("Define");
    expect(html).toContain("就绪");
  });

  it("phase-card blocked 状态显示阻塞徽章", () => {
    const html = REPORT_COMPONENTS["phase-card"]!.render({
      phase: "A",
      name: "Analyze",
      objective: "根因分析",
      detailHtml: "待数据",
      status: "blocked_by_data",
    });
    expect(html).toContain("阻塞");
  });

  it("reasoning-table 渲染推理步骤", () => {
    const html = REPORT_COMPONENTS["reasoning-table"]!.render({
      steps: [{ tool: "oee.realtime", finding: "OEE=85%", inference: "低于目标" }],
    });
    expect(html).toContain("<table");
    expect(html).toContain("oee.realtime");
    expect(html).toContain("低于目标");
  });

  it("action-button 触发 postMessage", () => {
    const html = REPORT_COMPONENTS["action-button"]!.render({
      tool: "nexus_advise",
      args: { line: "L01" },
      label: "生成建议",
    });
    expect(html).toContain("<button");
    expect(html).toContain("nexus_advise");
    expect(html).toContain("postMessage");
  });

  it("section 包装标题 + 内部 HTML", () => {
    const html = REPORT_COMPONENTS["section"]!.render({
      title: "KPI 概览",
      innerHtml: "<div>KPI</div>",
    });
    expect(html).toContain('class="section"');
    expect(html).toContain("KPI 概览");
    expect(html).toContain("<div>KPI</div>");
  });

  it("text-block 支持 muted/warn 变体", () => {
    const muted = REPORT_COMPONENTS["text-block"]!.render({
      text: "辅助说明",
      variant: "muted",
    });
    expect(muted).toContain("#64748b");
    const warn = REPORT_COMPONENTS["text-block"]!.render({
      text: "警告",
      variant: "warn",
    });
    expect(warn).toContain("#fb923c");
  });

  it("score-card 渲染评分 + 满分", () => {
    const html = REPORT_COMPONENTS["score-card"]!.render({
      value: 8.5,
      label: "主题一致性",
      max: 10,
    });
    expect(html).toContain("8.5");
    expect(html).toContain("主题一致性");
    expect(html).toContain("满分 10");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XSS 防护：所有组件对用户数据 escapeHtml
// ─────────────────────────────────────────────────────────────────────────────

describe("组件 XSS 防护", () => {
  const payload = `<script>alert('xss')</script>`;

  it("kpi-card 转义 label", () => {
    const html = REPORT_COMPONENTS["kpi-card"]!.render({ label: payload, value: "1" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("root-cause-tree 转义 rootCause", () => {
    const html = REPORT_COMPONENTS["root-cause-tree"]!.render({
      rootCause: payload,
      layers: [],
    });
    expect(html).not.toContain("<script>");
  });

  it("recommendation-card 转义 title", () => {
    const html = REPORT_COMPONENTS["recommendation-card"]!.render({ title: payload });
    expect(html).not.toContain("<script>");
  });

  it("phase-card 不转义 detailHtml（受控 HTML）但转义 phase/name", () => {
    const html = REPORT_COMPONENTS["phase-card"]!.render({
      phase: payload,
      name: "正常",
      objective: "正常",
      detailHtml: "<strong>正常</strong>",
      status: "ready",
    });
    // detailHtml 保留（受控），phase 转义
    expect(html).toContain("<strong>正常</strong>");
    expect(html).not.toContain(`<span class="badge badge-phase">${payload}`);
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 渲染器：ComponentLayout → 完整 HTML 端到端
// ─────────────────────────────────────────────────────────────────────────────

describe("renderReport 端到端", () => {
  it("渲染 DOCTYPE + style + title + 组件序列", () => {
    const layout: ComponentLayout = {
      reportType: "oee",
      title: "OEE 综合诊断报告",
      meta: { line: "L01", scenarioId: "anomaly" },
      components: [
        {
          name: "kpi-grid",
          data: { cards: [{ label: "OEE", value: "85%" }] },
          wrapper: { type: "section", title: "KPI 概览" },
        },
        {
          name: "root-cause-tree",
          data: { rootCause: "刀具磨损", layers: ["参数偏高"] },
          wrapper: { type: "section", title: "根因分析" },
        },
      ],
    };
    const html = renderReport(layout);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<style>");
    expect(html).toContain(REPORT_CSS.trim().slice(0, 20));
    expect(html).toContain("OEE 综合诊断报告");
    expect(html).toContain("L01");
    expect(html).toContain("场景：anomaly");
    // 组件序列
    expect(html).toContain("KPI 概览");
    expect(html).toContain("根因分析");
    expect(html).toContain("刀具磨损");
    expect(html).toContain("参数偏高");
  });

  it("内置 postMessage 安全脚本", () => {
    const layout: ComponentLayout = {
      reportType: "test",
      title: "T",
      components: [],
    };
    const html = renderReport(layout);
    expect(html).toContain("nexus_mcp");
    expect(html).toContain("postMessage");
  });

  it("未知组件降级 error-box（不崩溃）", () => {
    const layout: ComponentLayout = {
      reportType: "test",
      title: "T",
      components: [{ name: "non-existent-component", data: {} }],
    };
    const html = renderReport(layout);
    expect(html).toContain("error-box");
    expect(html).toContain("未知组件");
  });

  it("组件 render 抛错降级 error-box（不崩溃）", () => {
    const layout: ComponentLayout = {
      reportType: "test",
      title: "T",
      components: [
        { name: "trend-svg", data: { points: "not-an-array" as unknown as number[] } },
      ],
    };
    const html = renderReport(layout);
    // trend-svg 内部 map 会抛错，渲染器应捕获
    expect(html).toContain("error-box");
  });

  it("meta 缺省时仍渲染时间戳", () => {
    const layout: ComponentLayout = {
      reportType: "test",
      title: "T",
      components: [],
    };
    const html = renderReport(layout);
    expect(html).toContain("report-meta");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组件清单
// ─────────────────────────────────────────────────────────────────────────────

describe("getComponentManifest 组件清单", () => {
  it("返回全部 13+ 组件的 name/description/dataSchema", () => {
    const manifest = getComponentManifest();
    expect(manifest.length).toBeGreaterThanOrEqual(13);
    const names = manifest.map((m) => m.name);
    expect(names).toContain("kpi-card");
    expect(names).toContain("kpi-grid");
    expect(names).toContain("trend-svg");
    expect(names).toContain("evidence-table");
    expect(names).toContain("root-cause-tree");
    expect(names).toContain("fishbone-summary");
    expect(names).toContain("confidence-bar");
    expect(names).toContain("recommendation-card");
    expect(names).toContain("recommendation-list");
    expect(names).toContain("phase-card");
    expect(names).toContain("reasoning-table");
    expect(names).toContain("action-button");
    expect(names).toContain("section");
    expect(names).toContain("text-block");
    expect(names).toContain("score-card");

    for (const m of manifest) {
      expect(m.name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect(m.dataSchema).toBeTruthy();
    }
  });
});
