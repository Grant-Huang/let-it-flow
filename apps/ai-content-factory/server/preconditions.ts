import type { Precondition, StepTrace } from "../../../src/agent/types.js";
import { calledToolNames } from "../../../src/agent/precondition.js";

/**
 * 构建 AI Content Factory 应用的业务前置条件（V 层）。
 */
export function buildAiContentFactoryPreconditions(): Precondition[] {
  return [
    {
      id: "has_focused_thread",
      description: "撰写任何稿件前必须先调用 skill.thread_focuser 确定单一主线索",
      phase: "on_finalize",
      check: (trace: StepTrace[]) => {
        const tools = calledToolNames(trace);
        if (tools.has("skill.thread_focuser")) {
          return { met: true };
        }
        return {
          met: false,
          missingTool: "skill.thread_focuser",
          prompt: "请先调用 skill.thread_focuser 聚焦到单一主线索，不要堆砌多条线索",
        };
      },
    },
    {
      id: "podcast_before_article",
      description: "公众号长文必须基于已生成的口播稿决策",
      phase: "every_step",
      check: (trace: StepTrace[]) => {
        const tools = calledToolNames(trace);
        const hasArticle = tools.has("skill.write_wechat_article");
        const hasPodcast = tools.has("skill.write_podcast_script");
        if (hasArticle && !hasPodcast) {
          return {
            met: false,
            missingTool: "skill.write_podcast_script",
            prompt: "先写口播稿再写公众号文章",
          };
        }
        return { met: true };
      },
    },
    {
      id: "finalize_has_both",
      description: "finalize 时必须同时产出口播稿 + 公众号文章",
      phase: "on_finalize",
      check: (trace: StepTrace[]) => {
        const tools = calledToolNames(trace);
        const hasPodcast = tools.has("skill.write_podcast_script");
        const hasArticle = tools.has("skill.write_wechat_article");
        if (!hasPodcast || !hasArticle) {
          const missing: string[] = [];
          if (!hasPodcast) missing.push("skill.write_podcast_script");
          if (!hasArticle) missing.push("skill.write_wechat_article");
          return {
            met: false,
            missingTool: missing[0] ?? "unknown",
            prompt: `必须同时生成口播稿和公众号文章。缺少: ${missing.join("、")}`,
          };
        }
        return { met: true };
      },
    },
    {
      id: "publish_after_article",
      description: "发布草稿前必须已调用 skill.write_wechat_article 生成公众号文章",
      phase: "every_step",
      check: (trace: StepTrace[]) => {
        const tools = calledToolNames(trace);
        const hasPublish = tools.has("skill.publish_wechat_draft");
        const hasArticle = tools.has("skill.write_wechat_article");
        if (hasPublish && !hasArticle) {
          return {
            met: false,
            missingTool: "skill.write_wechat_article",
            prompt: "发布草稿前必须先调用 skill.write_wechat_article 生成公众号文章",
          };
        }
        return { met: true };
      },
    },
  ];
}
