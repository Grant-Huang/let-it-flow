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
import type { SkillConnector } from "../../../src/agent/skill-bridge.js";
import type { SkillRegistry } from "../../../src/agent/skill-registry.js";

/**
 * 构造 NexusOps 的 skill 列表。
 *
 * @param registry  可选的 SkillRegistry（自动沉淀的 active skill 合并进来）
 * @returns  手写 skill + registry active skill（去重 by name，手写优先）
 */
export function buildNexusSkills(registry?: SkillRegistry): SkillConnector[] {
  const handwritten: SkillConnector[] = [
    createOeeDiagnoseSkill(),
    createDowntimeRootCauseSkill(),
  ];
  // registry 的 active skill 暂时只占位（重建 SkillConnector 需 stepsPayload，
  // 由 skill-confirm 在登记 draft 时序列化；当前无 active skill 时返回手写）
  // 注：实际重建逻辑需 registry 存 stepsPayload + tool lookup，此处保留接口位
  void registry;
  return handwritten;
}
