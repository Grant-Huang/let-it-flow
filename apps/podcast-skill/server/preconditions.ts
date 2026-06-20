/**
 * Podcast-Skill 业务前置条件（V 内容）。
 *
 * 强制纪律（不靠 prompt 自觉，靠平台机制阻断）：
 *   - has_focused_thread：撰稿前必须先调 skill.thread_focuser
 *   - podcast_before_article：长文必须基于已完成的口播稿（每步检查）
 *   - finalize_has_both：finalize 前必须同时产出口播稿 + 公众号长文
 */
import { PreconditionRegistry, calledToolNames } from "../../../src/agent/precondition.js";
import type { Precondition } from "../../../src/agent/types.js";

export function buildPodcastSkillPreconditions(): PreconditionRegistry {
  const reg = new PreconditionRegistry();

  reg.register({
    id: "has_focused_thread",
    description: "撰写任何稿件前必须先调用 skill.thread_focuser 确定单一主线索",
    phase: "on_finalize",
    check: (trace) => {
      const called = calledToolNames(trace);
      const wroteAnything =
        called.has("skill.write_podcast_script") ||
        called.has("skill.write_wechat_article") ||
        called.has("podcast_finalize");
      const focused = called.has("skill.thread_focuser");
      if (wroteAnything && !focused) {
        return {
          met: false,
          missingTool: "skill.thread_focuser",
          prompt: "请先调 skill.thread_focuser 聚焦到单一主线索，不要堆砌多条线索。",
        };
      }
      return { met: true };
    },
  } satisfies Precondition);

  reg.register({
    id: "podcast_before_article",
    description: "公众号长文必须基于已生成的口播稿决策",
    phase: "every_step",
    check: (trace) => {
      const podcastDone = trace.some((t) =>
        t.toolCalls.some((tc) => !tc.rejected && tc.toolName === "skill.write_podcast_script"),
      );
      const articleAttempt = trace.some((t) =>
        t.toolCalls.some((tc) => !tc.rejected && tc.toolName === "skill.write_wechat_article"),
      );
      if (articleAttempt && !podcastDone) {
        return {
          met: false,
          missingTool: "skill.write_podcast_script",
          prompt: "请先调 skill.write_podcast_script 完成口播稿，再写公众号长文。",
        };
      }
      return { met: true };
    },
  } satisfies Precondition);

  reg.register({
    id: "finalize_has_both",
    description: "finalize 时必须同时产出口播稿 + 公众号文章",
    phase: "on_finalize",
    check: (trace) => {
      const called = calledToolNames(trace);
      if (!called.has("podcast_finalize")) return { met: true }; // 还没到收尾
      const missing: string[] = [];
      if (!called.has("skill.write_podcast_script")) missing.push("skill.write_podcast_script");
      if (!called.has("skill.write_wechat_article")) missing.push("skill.write_wechat_article");
      if (missing.length > 0) {
        return {
          met: false,
          missingTool: missing[0] ?? "skill.write_podcast_script",
          prompt: `收尾前必须同时产出口播稿 + 公众号长文，还缺：${missing.join(", ")}`,
        };
      }
      return { met: true };
    },
  } satisfies Precondition);

  return reg;
}

export function podcastSkillPreconditionList(reg: PreconditionRegistry): Precondition[] {
  return reg.list();
}
