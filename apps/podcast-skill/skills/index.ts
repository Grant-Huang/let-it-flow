/**
 * Podcast-Skill 沉淀流程入口（L 层）。
 *
 * MVP 提供 3 个 skill：
 *   - skill.thread_focuser：从素材聚焦到单一主线索（必要时返回 needsUserChoice）
 *   - skill.write_podcast_script：撰写口播稿（铁律自校验 + 重写 1 次）
 *   - skill.write_wechat_article：撰写公众号长文
 *
 * choose_narrative 暂用 LLM 直接在主 ReAct 决定（或写死分析师独白体），
 * 待 P10-b 沉淀为独立 skill + KB 完整 vault。
 */
import type { LanguageModel } from "ai";
import { createThreadFocuserSkill } from "./thread-focuser.js";
import { createWritePodcastScriptSkill } from "./write-podcast-script.js";
import { createWriteWechatArticleSkill } from "./write-wechat-article.js";
import type { SkillConnector } from "../../../src/agent/skill-bridge.js";

export function buildPodcastSkills(getModel: () => LanguageModel): SkillConnector[] {
  return [
    createThreadFocuserSkill(getModel),
    createWritePodcastScriptSkill(getModel),
    createWriteWechatArticleSkill(getModel),
  ];
}
