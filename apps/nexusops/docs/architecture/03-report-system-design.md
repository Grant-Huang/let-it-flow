# 03 - 报表系统设计（组件化 + LLM 编排 + 固化闭环）

**职责**：把报表生成从"skill 内部拼大段 HTML 字符串"重构为"LLM 输出组件序列 JSON，渲染器消费组件库生成 HTML"，并支持人工固化模板复用。

**核心原则（D7）**：LLM 输出组件序列 JSON，永远不输出原始 HTML。

---

## 1. 设计目标与约束

### 1.1 解决的问题

现有 `skill.report_html`（`apps/nexusops/skills/report-html.ts`）的问题：

| 问题 | 表现 | 根因 |
|---|---|---|
| 安全风险 | LLM 生成大段 HTML，潜在 XSS | HTML 字符串直接 `srcDoc` 注入 iframe |
| 风格不一致 | 每个模板各写一套 CSS | `SHARED_CSS` 只在 report-html.ts 内部共享 |
| 无法动态适配 | 模板写死字段（如 OEE 模板必含根因树） | LLM 无法根据实际数据增减组件 |
| 复用粒度粗 | 整个 OEE 模板要么全用要么不用 | 无法复用"KPI 卡片"到其他报告 |

### 1.2 约束（来自已确认决策）

- **D7**：LLM 输出组件序列 JSON，不碰 HTML → 组件库是受控渲染函数
- **D8**：固化形态是 JSON 配置（非 TS 函数）→ 存 SkillRegistry，运行时加载
- **D9**：固化入口在右栏 artifacts 栏 → `ArtifactSlot.tsx` 加按钮

---

## 2. 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  ① 组件库层（ReportComponents）                           │
│  - 受控的渲染函数集合（kpiCard / trendSvg / phaseCard）  │
│  - 每个函数：输入 data → 输出稳定 HTML 片段              │
│  - 内置统一 CSS，风格一致                                 │
└───────────────┬─────────────────────────────────────────┘
                ▲ data
┌───────────────┴─────────────────────────────────────────┐
│  ② 编排协议层（ComponentLayout JSON）                     │
│  - LLM 输出此 JSON：{components: [{name, data}]}         │
│  - 描述"用哪些组件、传什么数据"，不含任何 HTML            │
│  - 可被固化、可被复用、可被测试                            │
└───────────────┬─────────────────────────────────────────┘
                ▲ ComponentLayout
┌───────────────┴─────────────────────────────────────────┐
│  ③ 渲染器层（ReportRenderer）                             │
│  - 消费 ComponentLayout → 套 HTML 外壳 → 调组件函数拼装   │
│  - 注入 postMessage 安全脚本                              │
│  - 输出最终 HTML 字符串（给 iframe srcDoc）              │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 组件库（ReportComponents）

### 3.1 组件接口契约

每个组件是一个纯函数：输入强类型 data，输出 HTML 字符串。

```typescript
/**
 * 报表组件契约。
 * 每个组件是纯函数：输入 data，输出 HTML 片段（不含 <html><body> 外壳）。
 */
interface ReportComponent<TData = unknown> {
  /** 组件名（kebab-case，如 "kpi-card"）。 */
  name: string;
  /** 组件用途描述（给 LLM 看，帮助它选对组件）。 */
  description: string;
  /** 输入数据的 JSON Schema（给 LLM 看，告诉它该传什么字段）。 */
  dataSchema: Record<string, unknown>;
  /** 渲染函数。 */
  render: (data: TData) => string;
}
```

### 3.2 初始组件清单

从现有 `report-html.ts` 的 `SHARED_CSS` 和模板片段反推，组件库共 15 个组件（13 个业务组件 + 2 个容器/通用）：

| 组件名 | 用途 | 现有代码来源 | dataSchema 要点 |
|---|---|---|---|
| `kpi-card` | 单个 KPI 卡片（值 + 标签 + 目标 + 颜色） | `report-html.ts` KPI grid 内的 `.kpi-card` | `{label, value, target?, color?}` |
| `kpi-grid` | KPI 网格容器（包装多个 kpi-card） | `.kpi-grid` | `{cards: KpiCard[]}` |
| `trend-svg` | SVG 趋势折线图 | `.trend-svg` | `{points: number[], target?, label?}` |
| `evidence-table` | 证据链表格（工具 + 数据 + 步骤） | `.section > table` | `{rows: {tool, data, step}[]}` |
| `root-cause-tree` | 根因树（根因 + 5Why 层级） | `.tree` | `{rootCause, layers[]}` |
| `fishbone-summary` | 鱼骨图摘要（5M1E 分支标签） | `.aux-list` | `{branches: {dimension, factors[]}[]}` |
| `confidence-bar` | 置信度进度条 | `.confidence-bar` | `{label, value, color?}` |
| `recommendation-card` | 建议卡片（含可执行按钮） | `.rec-card` | `{title, rationale, impact, executionScore, actionTool?, actionArgs?}` |
| `recommendation-list` | 建议列表容器（包装多个 recommendation-card，批量渲染） | `.rec-list` | `{recommendations: RecommendationCard[]}` |
| `phase-card` | 阶段卡片（DMAIC 等用） | `.phase-card` | `{phase, name, objective, detail, status}` |
| `reasoning-table` | 推理链表格 | reasoningRows | `{steps: {action, tool, finding, inference}[]}` |
| `action-button` | 可执行按钮（触发 postMessage） | `.action-btn` | `{tool, args, label}` |
| `section` | 通用 section 容器（带标题） | `.section` | `{title, innerHtml}` |
| `text-block` | 通用文本块 | — | `{text, variant?}` |
| `score-card` | 评分卡片（质量评估报告专用，显示 0-10 分值 + 标签） | `.score-card` | `{value: number, label: string, max?: number}` |

### 3.3 组件库实现示例

```typescript
// apps/nexusops/skills/report-components.ts（新增文件）

import { escapeHtml } from "./report-utils.js";

/** 共享 CSS（从 report-html.ts 提取，所有组件复用）。 */
export const REPORT_CSS = `... 现有 SHARED_CSS ...`;

/** KPI 卡片组件。 */
export const kpiCard: ReportComponent<KpiCardData> = {
  name: "kpi-card",
  description: "单个 KPI 指标卡片，含数值、标签、目标值、颜色阈值。",
  dataSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "string" },
      target: { type: "string" },
      color: { type: "string", description: "CSS 颜色值" },
    },
    required: ["label", "value"],
  },
  render: (d) => `
    <div class="kpi-card">
      <div class="kpi-label">${escapeHtml(d.label)}</div>
      <div class="kpi-value" style="color:${d.color ?? "#e2e8f0"}">${escapeHtml(d.value)}</div>
      ${d.target ? `<div class="kpi-target">${escapeHtml(d.target)}</div>` : ""}
    </div>`,
};

interface KpiCardData {
  label: string;
  value: string;
  target?: string;
  color?: string;
}

/** 组件注册表（name → component）。 */
export const REPORT_COMPONENTS: Record<string, ReportComponent> = {
  "kpi-card": kpiCard,
  "trend-svg": trendSvg,
  "evidence-table": evidenceTable,
  // ... 所有组件
};

/** 获取组件清单（给 LLM 看的"组件说明书"）。 */
export function getComponentManifest(): Array<{name, description, dataSchema}> {
  return Object.values(REPORT_COMPONENTS).map((c) => ({
    name: c.name,
    description: c.description,
    dataSchema: c.dataSchema,
  }));
}
```

### 3.4 组件扩展规则

- 新增组件：在 `report-components.ts` 注册，必须实现 `ReportComponent` 接口
- 组件**不得**调用外部 API 或读取运行时状态（纯函数，保证可测试）
- 组件**不得**内联 `<script>`（所有交互通过 `action-button` 的 `postMessage` 协议）

---

## 4. ComponentLayout JSON 协议

### 4.1 协议定义

```typescript
/**
 * LLM 输出的组件序列 JSON。
 * 描述"用哪些组件、按什么顺序、传什么 data"。
 * 渲染器消费此 JSON 生成最终 HTML。
 */
interface ComponentLayout {
  /** 报告类型标识（用于固化模板匹配）。 */
  reportType: string;
  /** 报告标题。 */
  title: string;
  /** 报告元信息（展示用）。 */
  meta?: { line?: string; scenarioId?: string; generatedAt?: string };
  /** 组件实例序列（按顺序渲染）。 */
  components: ComponentInstance[];
}

interface ComponentInstance {
  /** 组件名（对应 REPORT_COMPONENTS 的 key）。 */
  name: string;
  /** 传给组件的数据（符合该组件的 dataSchema）。 */
  data: Record<string, unknown>;
  /** 可选的包装容器（如套一个 section）。 */
  wrapper?: { type: "section"; title?: string };
}
```

### 4.2 示例：DMAIC 报告的 ComponentLayout

```jsonc
{
  "reportType": "dmaic",
  "title": "DMAIC 改善路线图",
  "meta": { "line": "L01", "scenarioId": "anomaly" },
  "components": [
    {
      "name": "kpi-grid",
      "data": {
        "cards": [
          { "label": "长期 σ 水平", "value": "1.05", "target": "目标 4.0", "color": "#ef4444" },
          { "label": "DPMO", "value": "58000", "target": "目标 ≤3.4", "color": "#ef4444" },
          { "label": "Cpk", "value": "0.85", "target": "目标 ≥1.33", "color": "#ef4444" }
        ]
      },
      "wrapper": { "type": "section", "title": "6Sigma 水平概览" }
    },
    {
      "name": "phase-card",
      "data": { "phase": "D", "name": "Define（定义）", "objective": "明确课题范围", "detail": "...", "status": "ready" },
      "wrapper": { "type": "section", "title": "DMAIC 五阶段路线图" }
    },
    {
      "name": "reasoning-table",
      "data": { "steps": [/* ... */] },
      "wrapper": { "type": "section", "title": "推理链" }
    }
  ]
}
```

### 4.3 LLM 如何生成 ComponentLayout

LLM 收到两份输入：
1. **组件说明书**（`getComponentManifest()`）：可用组件 + 各自的 dataSchema
2. **分析数据**（本次 EvidenceEnvelope.data）：LLM 已收集的证据

LLM 输出 ComponentLayout JSON（通过结构化输出 / tool call）。

**Prompt 示例**（注入 system prompt）：
```
你现在需要生成一份可视化报告。请使用以下组件库组装报告：
${JSON.stringify(getComponentManifest(), null, 2)}

本次分析的数据：
${JSON.stringify(evidenceData, null, 2)}

请输出 ComponentLayout JSON（不要输出 HTML）。选择合适的组件展示数据，遵循：
- KPI 类数据用 kpi-grid
- 趋势类数据用 trend-svg
- 因果类数据用 root-cause-tree / fishbone-summary
- 阶段类数据用 phase-card
- 建议类数据用 recommendation-card
```

---

## 5. 渲染器（ReportRenderer）

### 5.1 核心逻辑

```typescript
// apps/nexusops/skills/report-renderer.ts（新增文件）

import { REPORT_COMPONENTS, REPORT_CSS } from "./report-components.js";

/**
 * 把 ComponentLayout 渲染为完整 HTML。
 * 此函数是受控的（LLM 不参与），保证安全性。
 */
export function renderReport(layout: ComponentLayout): string {
  const bodyParts: string[] = [];

  // 渲染标题区
  bodyParts.push(renderHeader(layout.title, layout.meta));

  // 按顺序渲染组件
  for (const inst of layout.components) {
    const component = REPORT_COMPONENTS[inst.name];
    if (!component) {
      bodyParts.push(`<div class="error">未知组件：${inst.name}</div>`);
      continue;
    }
    const innerHtml = component.render(inst.data);
    // 可选包装
    if (inst.wrapper?.type === "section") {
      bodyParts.push(renderSection(inst.wrapper.title, innerHtml));
    } else {
      bodyParts.push(innerHtml);
    }
  }

  return buildHtmlShell(layout.title, bodyParts.join("\n"));
}

function buildHtmlShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>${REPORT_CSS}</style>
</head>
<body>
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
```

### 5.2 安全保障

| 层 | 保障措施 |
|---|---|
| 组件层 | 组件是纯函数，不执行外部代码；所有用户数据经 `escapeHtml` 转义 |
| 渲染器层 | 只调已注册组件，未知组件降级为错误提示（不执行） |
| iframe 层 | `sandbox="allow-scripts allow-same-origin"`（现有），脚本只处理 `nexus_mcp` 类型 postMessage |
| postMessage 层 | 见 §6 安全协议 |

---

## 6. postMessage 安全协议

### 6.1 现有协议（保持不变）

`action-button` 组件生成的按钮，点击时发送：
```jsonc
{ "type": "nexus_mcp", "tool": "mcp.process.adjust_parameters", "args": {"temperature": 185} }
```

前端 `HtmlReportFrame`（`ArtifactSlot.tsx`）监听此消息，调 `onMcpAction(tool, args)`。

### 6.2 固化后的安全增强

LLM 只决定"放不放按钮、传什么 tool/args"。协议本身（`type: "nexus_mcp"`）由 `action-button` 组件固化生成，不会被 LLM 篡改。即使 LLM 输出恶意 args，前端 HITL 确认门（`requireConfirmation`）仍会拦截（见 `base.ts` 的 risk 评级）。

---

## 7. 报表固化闭环（D8 + D9 落地）

### 7.1 固化流程

```
LLM 分析完成，产出 EvidenceEnvelope.data（结构化）
        │
        ▼
┌─ 查 SkillRegistry.reportTemplates（active 模板）─────────┐
│                                                            │
│  命中 active 模板                          未命中           │
│   ↓                                         ↓              │
│  用模板 layout（JSON）                      LLM 编排：看 data + 组件库说明
│  填入 data → 渲染器 → HTML               产出 ComponentLayout（JSON）
│   ↓                                         ↓              │
│  iframe 渲染                              渲染器消费 → HTML
│                                            ↓              │
│                                          iframe 渲染      │
│                                            ↓              │
│  ┌─ 右栏 artifacts 栏显示报告 + "固化"按钮 ──────────────┐ │
│  │                                                        │ │
│  │  用户点击"固化" → 弹编辑器（可改 reportType/标题/组件）│ │
│  │     ↓                                                  │ │
│  │  确认 → registerReportTemplate(layout, "active")       │ │
│  │     ↓                                                  │ │
│  │  落 data/skills.json 的 reportTemplates 表             │ │
│  │     ↓                                                  │ │
│  │  下次同主题 → 走左边"命中模板"路径（0 LLM 调用）       │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 7.2 SkillRegistry 扩展

现有 `SkillRegistry`（`src/agent/skill-registry.ts`）已有 JSON 持久化（`data/skills.json`）。新增 `reportTemplates` 表：

```typescript
// 扩展 RegistryFile
interface RegistryFile {
  candidates: CandidateRecord[];
  skills: SkillRecord[];
  reportTemplates: ReportTemplateRecord[];  // 新增
}

interface ReportTemplateRecord {
  /** 报告类型标识（用于匹配，如 "dmaic" / "energy_anomaly"）。 */
  reportType: string;
  /** 模板标题。 */
  title: string;
  /** ComponentLayout 骨架（components 序列，data 字段为占位符）。 */
  layout: ComponentLayout;
  /** 状态。active = 已固化可用；draft = 试运行。 */
  status: "draft" | "active";
  /** 来源。manual = 人工固化；mined = 自动挖矿（未来）。 */
  source: "manual" | "mined";
  createdAt: string;
  updatedAt: string;
}

// SkillRegistry 新增方法
class SkillRegistry {
  /** 登记一个固化的报表模板。 */
  registerReportTemplate(record: Omit<ReportTemplateRecord, "createdAt" | "updatedAt">): void { /* ... */ }

  /** 按 reportType 查找 active 模板。 */
  getReportTemplate(reportType: string): ReportTemplateRecord | undefined { /* ... */ }

  /** 列出所有 active 模板。 */
  activeReportTemplates(): ReportTemplateRecord[] { /* ... */ }
}
```

### 7.3 固化入口（前端）

在 `ArtifactSlot.tsx` 的 `HtmlReportFrame` 旁边增加"固化"按钮：

```tsx
// ArtifactSlot.tsx 增强（伪代码）
function HtmlReportFrame({ html, layout, onMcpAction, onSolidify }: HtmlReportFrameProps) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 工具栏 */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        {onSolidify && layout && (
          <button onClick={() => onSolidify(layout)}>📌 固化为此主题模板</button>
        )}
      </div>
      {/* iframe */}
      <iframe srcDoc={html} sandbox="allow-scripts allow-same-origin" style={{ flex: 1 }} />
    </div>
  );
}
```

点击"固化"后：
1. 弹出编辑器（可改 reportType / 标题 / 删除某些组件）
2. 用户确认 → 调后端 API `POST /api/report-templates` → `SkillRegistry.registerReportTemplate`
3. 落 `data/skills.json`

### 7.4 渲染时的模板匹配逻辑

```typescript
// 报表生成入口
async function generateReport(topic: string, evidenceData: unknown): Promise<string> {
  // ① 先查 active 模板
  const template = registry.getReportTemplate(topic);
  if (template && template.status === "active") {
    // 用模板 layout，填入实际 data
    const filledLayout = fillTemplateData(template.layout, evidenceData);
    return renderReport(filledLayout);  // 0 LLM 调用，快且稳定
  }

  // ② 未命中 → LLM 编排
  const layout = await llmComposeLayout(topic, evidenceData);
  return renderReport(layout);
}
```

---

## 8. 从现有 report-html.ts 的迁移

### 8.1 迁移映射

| 现有代码（report-html.ts） | 迁移后 |
|---|---|
| `SHARED_CSS` | → `report-components.ts` 的 `REPORT_CSS` |
| `buildHtmlShell` | → `report-renderer.ts` 的 `buildHtmlShell` |
| `buildOeeBodyHtml` 的各片段 | → 拆成 `kpi-grid` / `trend-svg` / `evidence-table` 等组件调用 |
| `buildDmaicBodyHtml` 的各片段 | → 拆成 `phase-card` / `reasoning-table` 等组件调用 |
| `createReportHtmlSkill` 的 steps | → 改为：调 ToolResolver 取数 → LLM 编排 layout → renderReport |

### 8.2 兼容性

- **测试兼容**：现有测试断言（`_isHtmlReport`、`<!DOCTYPE html>`、含特定标题）保持不变。渲染器输出仍是完整 HTML，只是内部用组件拼装。
- **前端兼容**：`HtmlReportFrame` 的 iframe 渲染逻辑不变，只是新增"固化"按钮。
- **artifacts.ts 兼容**：`parseHtmlReportOutput` 仍解析 `data.html` 字段。

---

## 9. 开放问题

| # | 问题 | 当前倾向 | 状态 |
|---|---|---|---|
| Q1 | LLM 编排失败（输出非法 JSON）时如何兜底？ | 倾向：降级为"纯文本摘要"组件（`text-block`），保证有报告输出 | 已实现：report-html 在 LLM 编排失败时降级为固定模板取数渲染 |
| Q2 | 固化模板的 `fillTemplateData` 如何处理"本次数据缺某字段"？ | 倾向：缺字段时该组件跳过渲染，显示"数据不可用"占位 | 已实现：模板匹配路径直接用 layout（不填占位），未命中走正常工具取数 |
| Q3 | 是否支持"模板继承"（如 energy_anomaly 继承 oee 的部分组件）？ | 倾向：Phase 2 先不做，保持模板独立；未来按需引入 | 未做，保持独立 |

---

## 10. 质量评估报告（Phase 4 新增报告类型）

### 10.1 设计动机

LLM 主导编排后，分析质量不再由硬编码 skill 保证，需要一个**独立的自检机制**：用便宜模型（`nexus_review`）对主分析结果做多维评分，产出评估报告作为**右栏第二个 artifact**（与原分析报告并列展示）。

这解决了"LLM 自己说自己对不对"的信任问题——评估报告是独立产出，用户可对比判断。

### 10.2 评估维度（5 维度，每维 0-10 分）

| 维度 | 评估内容 | 诊断类（DMAIC/OEE） | 评估类（QS16949） |
|---|---|---|---|
| 主题一致性（topic_consistency） | 分析主题是否贯穿始终，有无漂移 | 严格：DMAIC 不能漂移到 OEE 根因 | 严格：QS16949 不能漂移到根因诊断 |
| 证据充分性（evidence_sufficiency） | 核心结论是否有足够工具调用支撑 | 工具调用数 + EvidenceEnvelope 链 | 同左 |
| 根因合理性（root_cause_rationality） | 根因是否符合 5Why 逻辑，鱼骨图覆盖 5M1E | 严格评分 | **中性分**（评估类不需要根因） |
| 建议可执行性（recommendation_actionability） | 建议项是否带 actionTool + impact/executionScore | 严格评分 | 严格评分（纠正措施可执行性） |
| 方法合规性（methodology_compliance） | 是否遵循所选方法论的阶段顺序 | 严格：D→M→A→I→C | 严格：scope→evidence→gap_analysis→improve |

### 10.3 评估报告的 ComponentLayout

质量评估报告本身也用组件库渲染（复用 Phase 1 的组件，不新建渲染路径）：

```jsonc
{
  "reportType": "quality_assessment",
  "title": "分析质量评估报告",
  "components": [
    // 总分卡片
    { "name": "score-card", "data": { "value": 7.5, "label": "总体评分", "max": 10 } },
    // 各维度评分网格
    { "name": "kpi-grid", "data": { "cards": [
        { "label": "主题一致性", "value": "8.5", "color": "#22c55e" },
        { "label": "证据充分性", "value": "7.0", "color": "#f59e0b" }
        // ...
    ] } },
    // 改进建议
    { "name": "text-block", "data": { "text": "改进建议：...", "variant": "warn" } }
  ]
}
```

### 10.4 评估器的两档实现

| 档位 | 触发条件 | 实现 | 评分稳定性 |
|---|---|---|---|
| LLM 档（主用） | 注入了 `nexus_review` 模型 | 用便宜模型 + 结构化 prompt 输出 JSON 评分 | 中（多维度降低单点偏差） |
| 启发式档（降级） | 无模型 / LLM 调用失败 | 基于轨迹的规则打分（工具数、是否含根因、是否含建议） | 高（但粗糙） |

**设计要点**：
- 评估器无状态，可独立调用（`evaluateAnalysisQuality` 函数）
- skill 形态（`skill.quality_evaluate`）与工具形态（`nexus_quality_evaluate`）共用评估内核，不重复实现
- 评估报告标注"参考性评分"（LLM 评估，非绝对标准），避免用户过度依赖

### 10.5 评估类问题的特殊处理

QS16949 内审评估是**符合性评估类**问题（非诊断类），评估器对其做差异化处理：
- `root_cause_rationality` 维度给中性分（这类问题本就不需要根因，不应因"无根因"而扣分）
- `methodology_compliance` 按 QS16949 的四阶段（scope→evidence→gap_analysis→improve）校验，而非 DMAIC 五阶段

这一区分由 `methodologyTopic` 参数传入，评估器据此判断问题类型。
