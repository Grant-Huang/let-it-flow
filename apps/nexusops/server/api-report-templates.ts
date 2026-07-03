/**
 * 报表模板固化路由（Phase 2 报表固化闭环）。
 *
 * 路由：
 *   GET    /api/report-templates            —— 列出全部模板（含 draft）
 *   GET    /api/report-templates/:reportType —— 按 reportType 查找 active 模板
 *   POST   /api/report-templates            —— 登记/更新一个固化模板（body = ReportTemplateRecord 草体）
 *   DELETE /api/report-templates/:reportType —— 删除一个模板
 *
 * 数据来源：SkillRegistry 的 reportTemplates 表（本地 JSON 持久化）。
 */
import { Hono } from "hono";
import type { SkillRegistry } from "../../../src/agent/skill-registry.js";
import type { ComponentLayout } from "../../../src/orchestrator/report-types.js";

/** 创建报表模板路由。 */
export function createReportTemplatesApp(skillRegistry: SkillRegistry): Hono {
  const app = new Hono();

  /** 列出全部模板（含 draft，供管理界面用）。 */
  app.get("/", (c) => {
    const templates = skillRegistry.allReportTemplates();
    return c.json({ status: "success", data: { templates, count: templates.length } });
  });

  /** 按 reportType 查找 active 模板（报表生成时用）。 */
  app.get("/:reportType", (c) => {
    const reportType = c.req.param("reportType");
    const template = skillRegistry.getReportTemplate(reportType);
    if (!template) {
      return c.json(
        { status: "error", message: `未找到 reportType="${reportType}" 的 active 模板` },
        404,
      );
    }
    return c.json({ status: "success", data: { template } });
  });

  /** 登记/更新一个固化模板（同 reportType 覆盖）。 */
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: "error", message: "请求体必须是合法 JSON" }, 400);
    }

    const parsed = parseTemplateInput(body);
    if (!parsed.ok) {
      return c.json({ status: "error", message: parsed.error }, 400);
    }

    const input = parsed.value;
    skillRegistry.registerReportTemplate({
      reportType: input.reportType,
      title: input.title,
      layout: input.layout,
      status: input.status ?? "active",
      source: input.source ?? "manual",
    });

    const saved = skillRegistry.getReportTemplate(input.reportType);
    return c.json({ status: "success", data: { template: saved } }, 201);
  });

  /** 删除一个模板。 */
  app.delete("/:reportType", (c) => {
    const reportType = c.req.param("reportType");
    const existed = skillRegistry.allReportTemplates().some((t) => t.reportType === reportType);
    if (!existed) {
      return c.json(
        { status: "error", message: `未找到 reportType="${reportType}" 的模板` },
        404,
      );
    }
    skillRegistry.deleteReportTemplate(reportType);
    return c.json({ status: "success", data: { deleted: reportType } });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入参校验
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateInput {
  reportType: string;
  title: string;
  layout: ComponentLayout;
  status?: "draft" | "active";
  source?: "manual" | "mined";
}

type ParseResult = { ok: true; value: TemplateInput } | { ok: false; error: string };

/** 校验 POST 入参（必填字段 + layout 结构）。 */
function parseTemplateInput(body: unknown): ParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "请求体必须是对象" };
  }
  const obj = body as Record<string, unknown>;

  const reportType = obj.reportType;
  if (typeof reportType !== "string" || reportType.trim() === "") {
    return { ok: false, error: "reportType 必须是非空字符串" };
  }

  const title = obj.title;
  if (typeof title !== "string" || title.trim() === "") {
    return { ok: false, error: "title 必须是非空字符串" };
  }

  const layoutResult = parseLayout(obj.layout);
  if (!layoutResult.ok) {
    return layoutResult;
  }

  const status = obj.status;
  if (status != null && status !== "draft" && status !== "active") {
    return { ok: false, error: 'status 只能是 "draft" 或 "active"' };
  }

  const source = obj.source;
  if (source != null && source !== "manual" && source !== "mined") {
    return { ok: false, error: 'source 只能是 "manual" 或 "mined"' };
  }

  return { ok: true, value: { reportType, title, layout: layoutResult.value, status, source } };
}

/** 校验 ComponentLayout 结构（reportType + title + components 数组）。 */
function parseLayout(layout: unknown): { ok: true; value: ComponentLayout } | { ok: false; error: string } {
  if (!layout || typeof layout !== "object") {
    return { ok: false, error: "layout 必须是对象" };
  }
  const l = layout as Record<string, unknown>;
  if (typeof l.reportType !== "string") {
    return { ok: false, error: "layout.reportType 必须是字符串" };
  }
  if (typeof l.title !== "string") {
    return { ok: false, error: "layout.title 必须是字符串" };
  }
  if (!Array.isArray(l.components)) {
    return { ok: false, error: "layout.components 必须是数组" };
  }
  for (let i = 0; i < l.components.length; i++) {
    const comp = l.components[i] as Record<string, unknown>;
    if (!comp || typeof comp.name !== "string") {
      return { ok: false, error: `layout.components[${i}].name 必须是字符串` };
    }
    if (!comp.data || typeof comp.data !== "object") {
      return { ok: false, error: `layout.components[${i}].data 必须是对象` };
    }
  }
  return { ok: true, value: l as unknown as ComponentLayout };
}
