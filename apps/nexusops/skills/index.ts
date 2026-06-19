/**
 * NexusOps skill 沉淀入口（应用层 —— L 内容）。
 *
 * 已验证的 ReAct 轨迹沉淀为 skill.<name> 工具，主循环可像调普通工具一样调用。
 * 本次提供 2 个 skill；自动沉淀逻辑留接口位（未来从 trace 提取）。
 */
import { createOeeDiagnoseSkill } from "./oee-diagnose.js";
import { createDowntimeRootCauseSkill } from "./downtime-root-cause.js";
import type { SkillConnector } from "../../../src/agent/skill-bridge.js";

export function buildNexusSkills(): SkillConnector[] {
  return [createOeeDiagnoseSkill(), createDowntimeRootCauseSkill()];
}
