import { routeTemplate, extractUrls } from "./templates.js";

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
 * @param routedTemplate   模板路由结果（routeTemplate(intent)）
 */
export function guardrailCheck(intent: string, routedTemplate: string | null): GuardrailResult {
  // 1) 越界：路由未命中 且 无可服务信号
  if (routedTemplate === null && !hasServiceableSignal(intent)) {
    return {
      decision: "reject",
      reason: "该请求超出当前工具链覆盖范围。",
      suggestRetry: "可服务能力：播客生成 / 网络检索分析 / 内容摘要总结。",
    };
  }

  // 2) 模糊：命中模板但缺关键参数
  const missing = findMissingParams(intent, routedTemplate);
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
 * podcast：必须有 topic 或 url（缺主体 → clarify）
 */
function findMissingParams(
  intent: string,
  templateId: string | null,
): Array<{ field: string; prompt: string }> {
  if (templateId === "podcast") {
    const hasUrl = extractUrls(intent).length > 0;
    // 简单启发：若既无 URL 又无明显主题词（仅"做播客"三个字），要求补充主题
    const hasTopicSignal = intent.length > 8 || /关于|主题|topic|的/.test(intent);
    if (!hasUrl && !hasTopicSignal) {
      return [{ field: "topic", prompt: "请提供播客主题或素材 URL（如：把 https://... 做成播客，或 做一期关于 AI 的播客）。" }];
    }
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
export { routeTemplate };
