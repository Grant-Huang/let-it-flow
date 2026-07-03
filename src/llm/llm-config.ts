/**
 * LLM 调用参数集中配置（callSite → 默认 params）。
 *
 * 设计目的：把散落在 planner / harness / narrate / review / evidence-gate / rewrite /
 * text-steps / quality-evaluator 等处的 temperature 魔法数字收敛到一处，
 * 便于统一调参、A/B 实验、以及按环境变量覆盖。
 *
 * 优先级链（高 → 低）：
 *   1. 显式调用方传参（generateText({ temperature })）—— 业务自定义覆盖
 *   2. call_site_bindings.json 的 params.temperature —— 部署期 JSON 覆盖
 *   3. 本文件 DEFAULT_CALL_SITE_PARAMS —— 代码内基线
 *
 * 注意：本表仅作"基线默认值"，调用方仍可显式传 temperature 覆盖。
 * 调用方未显式传时，应通过 resolveCallSiteParams(callSite) 读取本表。
 */
import type { CallSite } from "./call-sites.js";
import { CALL_SITES } from "./call-sites.js";

/** 单个调用点的默认参数。 */
export interface CallSiteParams {
  /** 采样温度（0=确定性，2=最发散）。 */
  temperature?: number;
  /** 最大输出 token 数。 */
  maxTokens?: number;
  /** nucleus sampling 概率。 */
  topP?: number;
}

/**
 * 各 callSite 的默认 temperature / maxTokens 基线值。
 *
 * 取值原则：
 *   - 推理/规划类（planner / nexus_agent / nexus_advise）：偏低，需结构化稳定
 *   - 改写/创作类（rewrite / image_prompts）：适中，保留文风多样性
 *   - 审计/术语统一类（review / evidence_gate / terminology）：极低，求稳
 *   - 叙述/解读类（narrate）：略高，叙述自然
 */
export const DEFAULT_CALL_SITE_PARAMS: Record<CallSite, CallSiteParams> = {
  /** DAG 规划（强推理）。 */
  planner: { temperature: 0.2 },
  /** 旁述改写（量大，step3）。 */
  rewrite: { temperature: 0.7 },
  /** 初译（step2）。沿用 rewrite 一致（创作型）。 */
  translate: { temperature: 0.7 },
  /** 接缝修复（step3b）：intro 略高保留文风。 */
  seam_repair: { temperature: 0.36 },
  /** 术语统一（step3c）：极低，求稳。 */
  terminology: { temperature: 0.05 },
  /** 生图提示词（step3d）：偏低，结构稳定。 */
  image_prompts: { temperature: 0.35 },
  /** ReAct Harness 主循环（多步 tool calling）。 */
  nexus_agent: { temperature: 0.2 },
  /** 结构化建议产出（ReAct finalize）。 */
  nexus_advise: { temperature: 0.2 },
  /** finalize 后可信度审计（便宜模型）。 */
  nexus_review: { temperature: 0.1 },
  /** 工具结果实时解读（轻量模型）。 */
  nexus_narrate: { temperature: 0.3, maxTokens: 120 },
  /** podcast-skill 应用 ReAct 主循环。 */
  podcast_skill_agent: { temperature: 0.2 },
};

/**
 * 解析某调用点的默认参数。
 *
 * 优先级：环境变量 `LIF_<CALLSITE>_TEMP`（如 LIF_PLANNER_TEMP）→ DEFAULT_CALL_SITE_PARAMS。
 * 环境变量为部署期临时调参提供入口，无需改代码。
 *
 * @param callSite  调用点
 * @returns 参数对象（temperature 等可选字段；未配置时返回空对象）
 */
export function resolveCallSiteParams(callSite: CallSite): CallSiteParams {
  const base = DEFAULT_CALL_SITE_PARAMS[callSite] ?? {};
  const envTemp = process.env[`LIF_${callSite.toUpperCase()}_TEMP`];
  const parsedTemp = envTemp !== undefined ? Number(envTemp) : undefined;
  if (parsedTemp !== undefined && !Number.isNaN(parsedTemp)) {
    return { ...base, temperature: parsedTemp };
  }
  return base;
}

/** 类型守卫：判断字符串是否为合法 CallSite。 */
export function isCallSite(s: string): s is CallSite {
  return (CALL_SITES as readonly string[]).includes(s);
}
