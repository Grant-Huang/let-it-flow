/**
 * NexusOps skill 沉淀入口（应用层 —— L 内容）。
 *
 * 已验证的 ReAct 轨迹沉淀为 skill.<name> 工具，主循环可像调普通工具一样调用。
 *
 * 两类 skill 来源：
 *   1. 手写 skill（oee_diagnose / downtime_root_cause）—— 已验证的最佳实践
 *   2. registry 的 active skill —— 自动沉淀 + draft 影子运行转正的产物
 *
 * buildNexusSkills 合并两类（去重 by name，手写优先）。
 */
import { createOeeDiagnoseSkill } from "./oee-diagnose.js";
import { createDowntimeRootCauseSkill } from "./downtime-root-cause.js";
import { createMultiPerspectiveRcaSkill } from "./multi-perspective-rca.js";
import { createCostSummarySkill } from "./cost-summary.js";
import { createWasteAuditSkill } from "./waste-audit.js";
import { createDmaicSkill } from "./dmaic.js";
import { createReportHtmlSkill } from "./report-html.js";
import { createGeneralAnalysisSkill } from "./general-analysis.js";
import { createQualityEvaluatorSkill } from "./quality-evaluator.js";
import type { SkillConnector } from "../../../src/agent/skill-bridge.js";
import { SkillRegistry } from "../../../src/agent/skill-registry.js";
import type { LanguageModel } from "ai";

/** skill 构建选项（Phase 4：注入评估模型）。 */
export interface SkillBuildOptions {
  /** 可选的 SkillRegistry（自动沉淀的 active skill 合并进来）。 */
  registry?: SkillRegistry;
  /** 质量评估器模型（便宜模型；缺省则用启发式降级评估）。 */
  qualityEvalModel?: LanguageModel;
  /** 评估模型兼容模式。 */
  qualityEvalCompatMode?: boolean;
}

/**
 * 构造 NexusOps 的 skill 列表。
 *
 * @param registryOrOpts  SkillRegistry（向后兼容）或完整选项对象
 * @returns  手写 skill + registry active skill（去重 by name，手写优先）
 */
export function buildNexusSkills(registryOrOpts?: SkillRegistry | SkillBuildOptions): SkillConnector[] {
  const opts: SkillBuildOptions = registryOrOpts instanceof SkillRegistry
    ? { registry: registryOrOpts }
    : (registryOrOpts ?? {});
  const registry = opts.registry;
  const handwritten: SkillConnector[] = [
    createOeeDiagnoseSkill(),
    createDowntimeRootCauseSkill(),
    createMultiPerspectiveRcaSkill(),
    createCostSummarySkill(),
    createWasteAuditSkill(),
    createDmaicSkill(),
    createReportHtmlSkill(registry ? { skillRegistry: registry } : {}),
    createGeneralAnalysisSkill(),
    createQualityEvaluatorSkill(
      opts.qualityEvalModel
        ? { model: opts.qualityEvalModel, compatMode: opts.qualityEvalCompatMode }
        : {},
    ),
  ];
  // registry 的 active skill 暂时只占位（重建 SkillConnector 需 stepsPayload，
  // 由 skill-confirm 在登记 draft 时序列化；当前无 active skill 时返回手写）
  // 注：report_html 已通过 skillRegistry 接入固化模板匹配（Phase 2.2）
  //     quality_evaluate 已通过 qualityEvalModel 接入 LLM 评估（Phase 4.6）
  return handwritten;
}
