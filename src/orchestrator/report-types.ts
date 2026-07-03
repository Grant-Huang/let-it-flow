/**
 * 报表组件化类型定义（L3 报表系统）。
 *
 * 设计见 apps/nexusops/docs/architecture/03-report-system-design.md。
 *
 * 核心原则（D7）：LLM 输出组件序列 JSON，永远不输出原始 HTML。
 * 三层架构：
 *   ① 组件库层（ReportComponents）—— 受控的渲染函数集合
 *   ② 编排协议层（ComponentLayout JSON）—— LLM 输出的组件序列
 *   ③ 渲染器层（ReportRenderer）—— 消费 ComponentLayout 生成 HTML
 */

/**
 * 报表组件契约。
 * 每个组件是纯函数：输入 data，输出 HTML 片段（不含 <html><body> 外壳）。
 */
export interface ReportComponent<TData = unknown> {
  /** 组件名（kebab-case，如 "kpi-card"）。 */
  name: string;
  /** 组件用途描述（给 LLM 看，帮助它选对组件）。 */
  description: string;
  /** 输入数据的 JSON Schema（给 LLM 看，告诉它该传什么字段）。 */
  dataSchema: Record<string, unknown>;
  /** 渲染函数：输入 data，输出 HTML 片段。 */
  render: (data: TData) => string;
}

/** 组件实例（ComponentLayout 的一项）。 */
export interface ComponentInstance {
  /** 组件名（对应 REPORT_COMPONENTS 的 key）。 */
  name: string;
  /** 传给组件的数据（符合该组件的 dataSchema）。 */
  data: Record<string, unknown>;
  /** 可选的包装容器（如套一个 section）。 */
  wrapper?: { type: "section"; title?: string };
}

/** 报告元信息（展示用）。 */
export interface ReportMeta {
  line?: string;
  scenarioId?: string;
  generatedAt?: string;
}

/**
 * LLM 输出的组件序列 JSON。
 * 描述"用哪些组件、按什么顺序、传什么 data"。
 * 渲染器消费此 JSON 生成最终 HTML。
 */
export interface ComponentLayout {
  /** 报告类型标识（用于固化模板匹配，如 "dmaic" / "oee"）。 */
  reportType: string;
  /** 报告标题。 */
  title: string;
  /** 报告元信息（展示用）。 */
  meta?: ReportMeta;
  /** 组件实例序列（按顺序渲染）。 */
  components: ComponentInstance[];
}

/** 固化模板记录（存 SkillRegistry）。 */
export interface ReportTemplateRecord {
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
