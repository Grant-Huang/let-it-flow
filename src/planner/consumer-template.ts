import type { WorkflowDAG } from "./dag-schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LlmService } from "../services/llm-service.js";

/**
 * 消费应用模板接口（平台内核与消费应用的扩展点边界）。
 *
 * 平台内核的 planner 在 LLM 选工具路径失败时，回退到消费应用注入的模板兜底。
 * 每个消费应用（如 podcast-generator）实现此接口并注入到 LetItFlow 配置。
 *
 * 内核不内置任何业务模板（podcast/research 等），保持纯净。
 */
export interface ConsumerTemplate {
  /** 模板 id（用于路由 + 日志）。 */
  templateId: string;
  /** 模板描述（供 guardrail 提示 + planner LLM 上下文）。 */
  description: string;
  /** 路由关键词正则（planner 判断意图是否命中此模板）。 */
  matchPattern: RegExp;
  /**
   * 判断意图是否命中此模板。
   * @param intent  用户意图
   * @param registry  工具注册表（可检查 domain 工具是否齐全）
   */
  match(intent: string, registry: ToolRegistry): boolean;
  /**
   * 从意图抽取模板参数（LLM 优先，失败回退启发式）。
   * @returns Zod schema 校验后的参数对象
   */
  extractParams(intent: string, llm: LlmService): Promise<unknown>;
  /**
   * 用抽取的参数构建 DAG。
   * @param params        extractParams 的返回值
   * @param fullPipeline  是否构建完整链（由消费应用自定义判定逻辑）
   */
  build(params: unknown, fullPipeline: boolean): WorkflowDAG;
  /**
   * 检测意图是否要求完整产物链（如 podcast 的"视频/配音"关键词）。
   * 缺省返回 false（仅文本子链）。
   */
  wantsFullPipeline?(intent: string): boolean;
  /**
   * 检查 registry 是否已注册此模板所需的全部 domain 工具。
   * 缺省返回 true（不校验）。
   */
  hasRequiredTools?(registry: ToolRegistry): boolean;
  /**
   * Guardrail 参数校验：意图命中模板后，检查是否缺关键参数。
   * @returns 缺失参数的提示问题数组（空表示参数齐全）
   */
  findMissingParams?(intent: string): Array<{ field: string; prompt: string }>;
}

/**
 * 从一组消费模板中路由到首个命中的模板 id。
 * 无命中返回 null。
 */
export function routeConsumerTemplate(
  intent: string,
  templates: ConsumerTemplate[],
  registry: ToolRegistry,
): string | null {
  for (const t of templates) {
    if (t.match(intent, registry)) return t.templateId;
  }
  return null;
}

/** 按 templateId 从模板列表中查找。 */
export function findTemplate(
  templateId: string,
  templates: ConsumerTemplate[],
): ConsumerTemplate | undefined {
  return templates.find((t) => t.templateId === templateId);
}
