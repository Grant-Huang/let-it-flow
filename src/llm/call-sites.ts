import { z } from "zod";

/**
 * 调用点枚举与绑定 schema（见 docs/13-p8-config-and-observability.md §13.3.2）。
 *
 * 全部 LLM 调用点在此枚举，禁止散落字符串字面量。
 * 新增调用点在此追加，并同步更新 DEFAULT_BINDINGS。
 */

/** 全部 LLM 调用点。 */
export const CALL_SITES = [
  "planner", // DAG 规划（强推理）
  "rewrite", // 旁述改写（量大，step3）
  "translate", // 初译（step2）
  "seam_repair", // 接缝修复（step3b）
  "terminology", // 术语统一（step3c）
  "image_prompts", // 生图提示词（step3d）
  "nexus_agent", // ReAct Harness 主循环（编排 LLM，多步 tool calling）
  "nexus_advise", // 结构化建议产出（ReAct finalize 节点）
  "podcast_skill_agent", // podcast-skill 应用 ReAct 主循环（内容策划 + 写稿）
] as const;
export type CallSite = (typeof CALL_SITES)[number];

/**
 * 调用点 → 模型绑定。每个调用点独立配置。
 */
export const CallSiteBinding = z.object({
  callSite: z.enum(CALL_SITES),
  /** 引用 ModelEndpoint 的 alias */
  modelAlias: z.string().min(1),
  /** 调用参数（覆盖模型默认）。可选 */
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
      topP: z.number().min(0).max(1).optional(),
    })
    .default({}),
  /** 是否启用 RobustOutputGuard（仅 structured 能力的调用点生效） */
  robustGuard: z.boolean().default(false),
});
export type CallSiteBinding = z.infer<typeof CallSiteBinding>;
