/**
 * Phase 2.5 报表固化闭环单元测试。
 *
 * 验证：
 *   - api-report-templates 路由 CRUD（GET/POST/DELETE）
 *   - 入参校验（reportType/title/layout 必填 + 结构校验）
 *   - skill.report_html 模板匹配：命中 active 模板走模板路径（0 工具调用）
 *   - 未命中模板走原 LLM 编排路径
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createReportTemplatesApp } from "../../../../apps/nexusops/server/api-report-templates.js";
import { SkillRegistry } from "../../../../src/agent/skill-registry.js";
import { createReportHtmlSkill } from "../../../../apps/nexusops/skills/report-html.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import type { ComponentLayout } from "../../../../src/orchestrator/report-types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nexus-rt-"));
  process.env.LIF_DATA_DIR = dataDir;
});

/** 构造一个可测试的 Hono app（只挂 report-templates 路由）。 */
function makeApp(skillRegistry: SkillRegistry): Hono {
  const app = new Hono();
  app.route("/api/report-templates", createReportTemplatesApp(skillRegistry));
  return app;
}

/** 构造一个最小 ComponentLayout。 */
function sampleLayout(reportType = "oee"): ComponentLayout {
  return {
    reportType,
    title: "测试报告",
    components: [
      { name: "kpi-card", data: { label: "OEE", value: "85%" } },
      { name: "section", data: { innerHtml: "<p>测试</p>" } },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API 路由 CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 2.5 report-templates API CRUD", () => {
  it("POST 登记模板 + GET 查询", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);

    const postRes = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "oee",
        title: "OEE 综合诊断报告",
        layout: sampleLayout("oee"),
      }),
    });
    expect(postRes.status).toBe(201);
    const postBody = await postRes.json();
    expect(postBody.status).toBe("success");
    expect(postBody.data.template.reportType).toBe("oee");
    expect(postBody.data.template.status).toBe("active");
    expect(postBody.data.template.source).toBe("manual");

    const getRes = await app.request("/api/report-templates/oee");
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.template.reportType).toBe("oee");
  });

  it("GET 列出全部模板（含 draft）", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);

    await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "dmaic",
        title: "DMAIC",
        layout: sampleLayout("dmaic"),
        status: "draft",
      }),
    });

    const listRes = await app.request("/api/report-templates");
    const listBody = await listRes.json();
    expect(listBody.data.count).toBe(1);
    expect(listBody.data.templates[0].status).toBe("draft");
  });

  it("GET 未命中的 reportType 返回 404", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);

    const res = await app.request("/api/report-templates/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("error");
  });

  it("DELETE 删除模板", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);

    await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "to-delete",
        title: "T",
        layout: sampleLayout("to-delete"),
      }),
    });

    const delRes = await app.request("/api/report-templates/to-delete", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.data.deleted).toBe("to-delete");

    // 删除后查询应 404
    const getRes = await app.request("/api/report-templates/to-delete");
    expect(getRes.status).toBe(404);
  });

  it("DELETE 不存在的模板返回 404", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST 同 reportType 覆盖（createdAt 保留，updatedAt 更新）", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);

    await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "oee",
        title: "旧标题",
        layout: sampleLayout("oee"),
      }),
    });

    await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "oee",
        title: "新标题",
        layout: sampleLayout("oee"),
      }),
    });

    const listRes = await app.request("/api/report-templates");
    const listBody = await listRes.json();
    expect(listBody.data.count).toBe(1);
    expect(listBody.data.templates[0].title).toBe("新标题");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 入参校验
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 2.5 report-templates 入参校验", () => {
  it("POST 缺 reportType 返回 400", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T", layout: sampleLayout() }),
    });
    expect(res.status).toBe(400);
  });

  it("POST 缺 title 返回 400", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportType: "oee", layout: sampleLayout() }),
    });
    expect(res.status).toBe(400);
  });

  it("POST layout 缺 components 数组返回 400", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "oee",
        title: "T",
        layout: { reportType: "oee", title: "T", components: "not-array" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST 非法 body（非 JSON）返回 400", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST 非法 status 值返回 400", async () => {
    const reg = new SkillRegistry();
    const app = makeApp(reg);
    const res = await app.request("/api/report-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: "oee",
        title: "T",
        layout: sampleLayout(),
        status: "invalid",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skill.report_html 模板匹配
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 2.5 skill.report_html 模板匹配", () => {
  /** 构造一个带工具的 registry（供 skill 步骤内的 ctx.call 工作）。 */
  function makeToolRegistry(skill: ReturnType<typeof createReportHtmlSkill>): ToolRegistry {
    const reg = new ToolRegistry();
    for (const c of buildNexusTools()) {
      if (!reg.has(c.name)) reg.register(c);
    }
    // 把被测 skill 本身也注册进去（避免 ctx.call("skill.report_html") 解析失败）
    if (!reg.has(skill.name)) reg.register(skill);
    return reg;
  }

  /** 执行 skill（模拟 harness 调用，参考 test-nexus-kb-skills 的 runSkill）。 */
  async function runSkill(
    skill: ReturnType<typeof createReportHtmlSkill>,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const toolRegistry = makeToolRegistry(skill);
    const ctx = {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      args,
      emit: async () => ({} as never),
      requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined,
      resolveTool: (name: string) => toolRegistry.get(name),
    } as unknown as Parameters<import("../../../../src/tools/base.js").FlowConnector["execute"]>[1];
    const gen = skill.execute(args, ctx);
    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const output = final!.output as { data: Record<string, unknown> };
    return output.data;
  }

  it("命中 active 模板时走模板路径（fromTemplate=true，不调工具取数）", async () => {
    const reg = new SkillRegistry();
    reg.registerReportTemplate({
      reportType: "oee",
      title: "固化的 OEE 模板",
      layout: sampleLayout("oee"),
      status: "active",
      source: "manual",
    });

    const skill = createReportHtmlSkill({ skillRegistry: reg });
    const data = await runSkill(skill, { reportType: "oee", line: "L01", scenarioId: "normal" });

    expect(data._isHtmlReport).toBe(true);
    expect(data.fromTemplate).toBe(true);
    expect(data.html).toContain("<!DOCTYPE html>");
    expect(data.html).toContain("固化的 OEE 模板");
  });

  it("未命中模板时走原 LLM 编排路径（fromTemplate 不存在）", async () => {
    const reg = new SkillRegistry();
    const skill = createReportHtmlSkill({ skillRegistry: reg });
    const data = await runSkill(skill, { reportType: "oee", line: "L01", scenarioId: "normal" });

    expect(data._isHtmlReport).toBe(true);
    expect(data.fromTemplate).toBeUndefined();
    expect(data.html).toContain("OEE 综合诊断报告");
  });

  it("draft 状态模板不被匹配（只匹配 active）", async () => {
    const reg = new SkillRegistry();
    reg.registerReportTemplate({
      reportType: "oee",
      title: "草稿模板",
      layout: sampleLayout("oee"),
      status: "draft",
      source: "manual",
    });

    const skill = createReportHtmlSkill({ skillRegistry: reg });
    const data = await runSkill(skill, { reportType: "oee", line: "L01", scenarioId: "normal" });

    // draft 不命中，走原实时取数路径（OEE 综合诊断报告标题）
    expect(data.fromTemplate).toBeUndefined();
    expect(data.html).toContain("OEE 综合诊断报告");
  });
});
