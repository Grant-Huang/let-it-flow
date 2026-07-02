/**
 * 证据源地图动态生成器（T 内容 —— 从 ToolRegistry 派生）。
 *
 * 把已注册的 domain 工具按域前缀分组，格式化成 LLM 友好的"证据源地图"文本，
 * 拼接到 system prompt。让 LLM 在会话启动时就建立"域→工具→证据性质"的心智模型，
 * 知道该查哪组工具、每个工具返回的证据多可信。
 *
 * 设计要点：
 *   - 只列 domain 层工具（取证类），core/nexus/skill 由其他段落覆盖
 *   - 按工具名前缀（oee/equipment/...）自动分组，无需硬编码域清单
 *   - description 含"第一取证点/首选"的排前并标记，帮 LLM 快速定位入口工具
 *   - evidenceMeta 缺失时降级为不显示 [confidence/freshness] 标签
 */
import type { FlowConnector } from "../../../src/tools/base.js";
import type { ToolRegistry } from "../../../src/tools/registry.js";

/** 触发"第一取证点"标记的关键词（出现在 description 或 triggers 中即命中）。 */
const PRIMARY_KEYWORDS = ["第一取证点", "首选", "primary", "第一时间"];

/** 域中文标签映射（让地图更易读；未知域回退为前缀本身）。 */
const DOMAIN_LABELS: Record<string, string> = {
  oee: "OEE 效率综合指标",
  equipment: "设备状态",
  quality: "质量",
  process: "工艺参数",
  energy: "能耗",
  schedule: "排产",
  material: "物料/WIP",
  personnel: "人员",
  lean: "精益分析",
};

/**
 * 从 ToolRegistry 动态生成证据源地图文本。
 *
 * @param registry  已注册全部工具的注册表
 * @returns  格式化字符串（可直接拼到 system prompt）。无 domain 工具时返回空字符串。
 */
export function buildEvidenceMap(registry: ToolRegistry): string {
  const domainTools = registry.listByTiers(["domain"]);
  if (domainTools.length === 0) return "";

  // 按前缀分组，保持插入顺序（Map 保序）
  const groups = new Map<string, FlowConnector[]>();
  for (const tool of domainTools) {
    const prefix = tool.name.split(".")[0] ?? "other";
    const arr = groups.get(prefix) ?? [];
    arr.push(tool);
    groups.set(prefix, arr);
  }

  const sections: string[] = ["## 证据源地图（按精益域分组，动态生成）"];
  for (const [prefix, tools] of groups) {
    const label = DOMAIN_LABELS[prefix] ?? prefix;
    sections.push(`### ${prefix} 域（${label}）`);

    // 组内排序：第一取证点排前
    const sorted = [...tools].sort((a, b) => {
      const aPrimary = isPrimaryTool(a) ? 0 : 1;
      const bPrimary = isPrimaryTool(b) ? 0 : 1;
      return aPrimary - bPrimary;
    });

    for (const tool of sorted) {
      const parts: string[] = [`- ${tool.name}`];
      const meta = formatMeta(tool);
      if (meta) parts.push(meta);
      if (isPrimaryTool(tool)) parts.push("[第一取证点]");
      parts.push(`- ${truncateDescription(tool.description)}`);
      sections.push(parts.join(" "));
    }
  }

  return sections.join("\n");
}

/** 判断工具是否为"第一取证点"（description 或 triggers 含关键词）。 */
function isPrimaryTool(tool: FlowConnector): boolean {
  const desc = tool.description.toLowerCase();
  if (PRIMARY_KEYWORDS.some((k) => desc.includes(k.toLowerCase()))) return true;
  const triggers = tool.whenToUse?.triggers ?? [];
  return triggers.some((t) =>
    PRIMARY_KEYWORDS.some((k) => t.toLowerCase().includes(k.toLowerCase())),
  );
}

/** 格式化 evidenceMeta 为 [confidence/freshness] 标签；无 meta 返回空串。 */
function formatMeta(tool: FlowConnector): string {
  const meta = tool.evidenceMeta;
  if (!meta) return "";
  const conf = meta.confidence ?? "?";
  const fresh = meta.freshness ?? "?";
  return `[${conf}/${fresh}]`;
}

/** 截断 description 到合理长度（避免单行过长撑爆 system prompt）。 */
function truncateDescription(desc: string, maxLen = 60): string {
  const cleaned = desc.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}
