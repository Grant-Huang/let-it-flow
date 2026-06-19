/**
 * 内核通用模板辅助（非业务模板）。
 *
 * 业务模板（podcast 等）已迁移到消费应用，内核只保留：
 *   - extractUrls：URL 抽取（通用工具）
 *   - routeTemplate：通用兜底路由（research/summary；podcast 等业务模板由消费应用注入）
 *   - TEMPLATES：通用骨架描述（供 guardrail 提示）
 *
 * 平台内核不内置任何业务（podcast）模板。
 */

/** 从意图粗抽取 URL（通用工具，供消费模板复用）。 */
export function extractUrls(intent: string): string[] {
  const re = /https?:\/\/[^\s，。、）)」"']+/gi;
  return intent.match(re) ?? [];
}

/**
 * 通用兜底路由（research/summary）。
 *
 * 业务模板（podcast 等）的路由由消费应用通过 ConsumerTemplate.match() 注入，
 * planner 在 consumerTemplates 未命中时才查此通用兜底。
 */
const GENERAL_RULES: Array<[string, RegExp]> = [
  ["research", /分析|研究|调研|对比|综述|investigate|analyze|research|compare/],
  ["summary", /总结|摘要|概括|提炼|summarize|digest/],
];

/** 路由到通用模板 id；未命中返回 null。 */
export function routeTemplate(intent: string): string | null {
  for (const [id, pattern] of GENERAL_RULES) {
    if (pattern.test(intent)) return id;
  }
  return null;
}

/** 模板骨架（供 guardrail 提示 + planner LLM 上下文）。 */
export interface TemplateSkeleton {
  templateId: string;
  description: string;
}

export const TEMPLATES: Record<string, TemplateSkeleton> = {
  research: {
    templateId: "research",
    description: "研究分析：web_search → web_fetch → llm整合 → deliver",
  },
  summary: {
    templateId: "summary",
    description: "内容摘要：web_fetch → llm总结 → deliver",
  },
};
