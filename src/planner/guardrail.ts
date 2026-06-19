import { routeTemplate, extractUrls } from "./templates.js";
import type { ConsumerTemplate } from "./consumer-template.js";
import { findTemplate } from "./consumer-template.js";

/**
 * Guardrail —— 意图护栏（见 06 §6.7）。
 * planner 入口前的可行性判断层，MVP 走规则层。
 *
 * 三种处理路径（按"可行 > 模糊 > 越界"顺序判定）：
 *   - proceed：命中模板 + 关键参数齐全 → 进入 LLM 填参
 *   - clarify：命中模板但缺关键参数 → clarification_required
 *   - reject：路由未命中 且 无可服务信号 → rejected
 */
export interface ClarifyQuestion {
  field: string;
  prompt: string;
  required: boolean;
}

export interface GuardrailResult {
  decision: "proceed" | "clarify" | "reject";
  /** clarify 时要问的问题。 */
  questions?: ClarifyQuestion[];
  /** reject 时的友好原因 + 重试建议。 */
  reason?: string;
  suggestRetry?: string;
  /** 命中的模板 id（proceed/clarify 时有）。 */
  templateId?: string;
}

/**
 * 规则层 guardrail。
 * @param intent           用户意图
 * @param routedTemplate   模板路由结果（routeTemplate / 消费模板 match）
 * @param consumerTemplates  消费应用注入的模板（用于查 findMissingParams）
 */
export function guardrailCheck(
  intent: string,
  routedTemplate: string | null,
  consumerTemplates: ConsumerTemplate[] = [],
): GuardrailResult {
  // 1) 越界：路由未命中 且 无可服务信号
  if (routedTemplate === null && !hasServiceableSignal(intent)) {
    return {
      decision: "reject",
      reason: "该请求超出当前工具链覆盖范围。",
      suggestRetry: "可服务能力：播客生成 / 网络检索分析 / 内容摘要总结。",
    };
  }

  // 2) 模糊：命中模板但缺关键参数（由消费模板自定义校验）
  const missing = findMissingParams(intent, routedTemplate, consumerTemplates);
  if (missing.length > 0) {
    return {
      decision: "clarify",
      templateId: routedTemplate ?? undefined,
      questions: missing.map((m) => ({ field: m.field, prompt: m.prompt, required: true })),
    };
  }

  // 3) 可行
  return { decision: "proceed", templateId: routedTemplate ?? undefined };
}

/**
 * 检测命中模板的意图是否缺关键参数。
 * 通过消费模板的 findMissingParams 校验（内核不硬编码业务规则）。
 */
function findMissingParams(
  intent: string,
  templateId: string | null,
  consumerTemplates: ConsumerTemplate[],
): Array<{ field: string; prompt: string }> {
  if (!templateId) return [];
  const tmpl = findTemplate(templateId, consumerTemplates);
  if (tmpl?.findMissingParams) {
    return tmpl.findMissingParams(intent);
  }
  return [];
}

/** 关键词扫描：意图是否落在可服务能力范围（播客/检索/摘要等）。 */
function hasServiceableSignal(intent: string): boolean {
  return /播客|podcast|检索|搜索|分析|研究|总结|摘要|概括|生成|制作|写|search|analyze|summarize|generate/.test(
    intent,
  );
}

/** 重新导出 routeTemplate 便于 planner 单点导入。 */
export { routeTemplate, extractUrls };
