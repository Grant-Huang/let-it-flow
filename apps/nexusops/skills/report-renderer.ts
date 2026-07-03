/**
 * 报表渲染器（L3 报表系统 —— 渲染器层）。
 *
 * 设计见 apps/nexusops/docs/architecture/03-report-system-design.md §5。
 *
 * 消费 ComponentLayout → 套 HTML 外壳 → 调组件函数拼装 → 输出完整 HTML。
 * 此函数是受控的（LLM 不参与），保证安全性。
 *
 * 内置 postMessage 安全脚本（只处理 nexus_mcp 类型）。
 */
import { REPORT_COMPONENTS, REPORT_CSS, escapeHtml } from "./report-components.js";
import type { ComponentLayout, ComponentInstance, ReportMeta } from "../../../src/orchestrator/report-types.js";

/**
 * 把 ComponentLayout 渲染为完整 HTML。
 * @param layout  LLM 输出的组件序列 JSON
 * @returns       完整 HTML 字符串（含 DOCTYPE + style + body + script）
 */
export function renderReport(layout: ComponentLayout): string {
  const bodyParts: string[] = [];

  // 按顺序渲染组件（header 由 buildHtmlShell 统一渲染，避免重复）
  for (const inst of layout.components) {
    const html = renderComponentInstance(inst);
    bodyParts.push(html);
  }

  return buildHtmlShell(layout.title, bodyParts.join("\n"), layout.meta);
}

/** 渲染单个组件实例（含可选 wrapper）。 */
function renderComponentInstance(inst: ComponentInstance): string {
  const component = REPORT_COMPONENTS[inst.name];
  if (!component) {
    return `<div class="error-box">未知组件：${escapeHtml(inst.name)}</div>`;
  }

  let innerHtml: string;
  try {
    innerHtml = component.render(inst.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `<div class="error-box">组件 ${escapeHtml(inst.name)} 渲染失败：${escapeHtml(msg)}</div>`;
  }

  // 可选包装
  if (inst.wrapper?.type === "section") {
    return renderSection(inst.wrapper.title, innerHtml);
  }
  return innerHtml;
}

/** 渲染 section 容器。 */
function renderSection(title: string | undefined, innerHtml: string): string {
  return `<div class="section">
  ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
  ${innerHtml}
</div>`;
}

/** 格式化元信息为可读字符串。 */
function formatMeta(meta?: ReportMeta): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.line) parts.push(meta.line);
  if (meta.scenarioId) parts.push(`场景：${meta.scenarioId}`);
  if (meta.generatedAt) parts.push(meta.generatedAt);
  if (parts.length === 0) return "";
  return parts.join(" · ");
}

/** 构造完整 HTML 外壳。 */
function buildHtmlShell(title: string, body: string, meta?: ReportMeta): string {
  const metaStr = formatMeta(meta);
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="header-row">
  <div class="report-title">${escapeHtml(title)}</div>
  ${metaStr ? `<div class="report-meta">${metaStr}</div>` : `<div class="report-meta">${new Date().toLocaleString("zh-CN", { hour12: false })}</div>`}
</div>
${body}
<script>
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'nexus_mcp') {
      window.parent.postMessage(e.data, '*');
    }
  });
</script>
</body>
</html>`;
}
