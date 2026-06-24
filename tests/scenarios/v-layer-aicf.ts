/**
 * V 层场景（AI Content Factory）：前置条件 —— 一致性保障。
 *
 * 与 v-layer.ts（NexusOps V 层）的区别：
 *   - apps/ai-content-factory/server/preconditions.ts 返回 Precondition[]（非 PreconditionRegistry）。
 *   - 三条规则覆盖内容生产流水线的"工序齐全"约束：
 *       1. has_focused_thread：写任何稿件前必须先聚焦主线索
 *       2. podcast_before_article：公众号文章必须基于口播稿
 *       3. finalize_has_both：finalize 时必须同时产出双产物
 *
 * 这组场景填补的缺口：podcast 重构后 V 层机制是否被正确触发，此前无离线场景锁。
 */
import type { Scenario } from "./types.js";
import type { Precondition, StepTrace } from "../../src/agent/types.js";
import { buildAiContentFactoryPreconditions } from "../../apps/ai-content-factory/server/preconditions.js";

/** 从 aicf preconditions 数组按 id 取一条。 */
function findPrecondition(all: Precondition[], id: string): Precondition {
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`aicf precondition 未找到：${id}`);
  return p;
}

/** 构造一条只含指定工具调用的 trace。 */
function traceWithTools(toolNames: string[], finishReason = "tool-calls"): StepTrace[] {
  return [
    {
      stepNumber: 0,
      thought: "t",
      toolCalls: toolNames.map((name, i) => ({
        id: `tc${i}`,
        toolName: name,
        args: {},
        result: {},
        durationMs: 0,
      })),
      finishReason,
      usage: { totalTokens: 10 },
      durationMs: 0,
    },
  ];
}

/** 取 check 结果的 missingTool（满足时返回 null）。 */
function missingToolOf(p: Precondition, trace: StepTrace[]): string | null {
  const r = p.check(trace);
  return r.met ? null : r.missingTool;
}

export const scenarioVa1FocuserGate: Scenario = {
  id: "V-A1",
  layer: "V",
  title: "aicf：写稿件前未聚焦主线索 → has_focused_thread 拦截",
  hypothesis: "agent 直接调用 write_podcast_script，但没先调 thread_focuser 聚焦",
  purpose: "验证 has_focused_thread（on_finalize）能检测到聚焦缺失，返回 missingTool=skill.thread_focuser",
  procedure: [
    "加载 buildAiContentFactoryPreconditions()",
    "构造一条只含 write_podcast_script、finishReason=nexus_finalize 的 trace",
    "断言 has_focused_thread.check 返回 met=false 且 missingTool=skill.thread_focuser",
    "对照：trace 含 thread_focuser → met=true",
  ],
  calls: [
    { target: "buildAiContentFactoryPreconditions / has_focused_thread.check", kind: "real", note: "真实 aicf V 层规则（聚焦门）" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的未聚焦 trace" },
  ],
  assertions: [
    {
      name: "未聚焦 → finalize 拦截",
      expected: "met=false, missingTool=skill.thread_focuser",
    },
    {
      name: "已聚焦 → 放行",
      expected: "trace 含 skill.thread_focuser → met=true",
    },
  ],
  async run() {
    const all = buildAiContentFactoryPreconditions();
    const p = findPrecondition(all, "has_focused_thread");

    const blocked = missingToolOf(p, traceWithTools(["skill.write_podcast_script"], "nexus_finalize"));
    this.assertions[0]!.actual = `未聚焦 → missingTool=${blocked}`;
    this.assertions[0]!.passed = blocked === "skill.thread_focuser";

    const ok = missingToolOf(p, traceWithTools(["skill.thread_focuser", "skill.write_podcast_script"], "nexus_finalize"));
    this.assertions[1]!.actual = `已聚焦 → missingTool=${ok}`;
    this.assertions[1]!.passed = ok === null;
  },
};

export const scenarioVa2ArticleBeforePodcast: Scenario = {
  id: "V-A2",
  layer: "V",
  title: "aicf：未写口播稿就写公众号文章 → podcast_before_article 每步提醒",
  hypothesis: "agent 跳过口播稿直接写公众号文章（every_step 检查）",
  purpose: "验证 podcast_before_article 规则在'有文章无口播稿'时返回 met=false，提示先写口播稿",
  procedure: [
    "加载 aicf preconditions，取 podcast_before_article（every_step）",
    "构造只含 write_wechat_article 的 trace → 断言 met=false",
    "对照：trace 同时含 write_podcast_script → met=true",
  ],
  calls: [
    { target: "buildAiContentFactoryPreconditions / podcast_before_article.check", kind: "real", note: "真实 aicf every_step 工序门" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的缺工序 trace" },
  ],
  assertions: [
    {
      name: "有文章无口播稿 → 提醒",
      expected: "met=false, missingTool=skill.write_podcast_script",
    },
    {
      name: "口播稿在前 → 放行",
      expected: "trace 含 write_podcast_script（无论是否含 write_wechat_article）→ met=true",
    },
  ],
  async run() {
    const all = buildAiContentFactoryPreconditions();
    const p = findPrecondition(all, "podcast_before_article");

    const blocked = missingToolOf(p, traceWithTools(["skill.write_wechat_article"]));
    this.assertions[0]!.actual = `有文章无口播稿 → missingTool=${blocked}`;
    this.assertions[0]!.passed = blocked === "skill.write_podcast_script";

    const ok = missingToolOf(p, traceWithTools(["skill.write_podcast_script", "skill.write_wechat_article"]));
    this.assertions[1]!.actual = `口播稿在前 → missingTool=${ok}`;
    this.assertions[1]!.passed = ok === null;
  },
};

export const scenarioVa3FinalizeHasBoth: Scenario = {
  id: "V-A3",
  layer: "V",
  title: "aicf：finalize 缺任一双产物 → finalize_has_both 拦截",
  hypothesis: "agent finalize 时只产出了口播稿，没产出公众号文章",
  purpose: "验证 finalize_has_both（on_finalize）检测双产物齐全，缺任一即拦截并指出缺哪个",
  procedure: [
    "加载 aicf preconditions，取 finalize_has_both",
    "构造只含 write_podcast_script 的 finalize trace → 断言 missingTool=skill.write_wechat_article",
    "构造只含 write_wechat_article 的 finalize trace → 断言 missingTool=skill.write_podcast_script",
    "对照：trace 含双产物 → met=true",
  ],
  calls: [
    { target: "buildAiContentFactoryPreconditions / finalize_has_both.check", kind: "real", note: "真实 aicf finalize 双产物门" },
    { target: "StepTrace 输入", kind: "synthetic", note: "手搓的缺产物 trace" },
  ],
  assertions: [
    {
      name: "只有口播稿 → 拦截缺文章",
      expected: "missingTool=skill.write_wechat_article",
    },
    {
      name: "只有文章 → 拦截缺口播稿",
      expected: "missingTool=skill.write_podcast_script",
    },
    {
      name: "双产物齐全 → 放行",
      expected: "met=true（missingTool=null）",
    },
  ],
  async run() {
    const all = buildAiContentFactoryPreconditions();
    const p = findPrecondition(all, "finalize_has_both");

    const onlyPodcast = missingToolOf(p, traceWithTools(["skill.thread_focuser", "skill.write_podcast_script"], "nexus_finalize"));
    this.assertions[0]!.actual = `只有口播稿 → missingTool=${onlyPodcast}`;
    this.assertions[0]!.passed = onlyPodcast === "skill.write_wechat_article";

    const onlyArticle = missingToolOf(p, traceWithTools(["skill.thread_focuser", "skill.write_wechat_article"], "nexus_finalize"));
    this.assertions[1]!.actual = `只有文章 → missingTool=${onlyArticle}`;
    this.assertions[1]!.passed = onlyArticle === "skill.write_podcast_script";

    const both = missingToolOf(p, traceWithTools(["skill.thread_focuser", "skill.write_podcast_script", "skill.write_wechat_article"], "nexus_finalize"));
    this.assertions[2]!.actual = `双产物齐全 → missingTool=${both}`;
    this.assertions[2]!.passed = both === null;
  },
};

export const aicfVLayerScenarios: Scenario[] = [
  scenarioVa1FocuserGate,
  scenarioVa2ArticleBeforePodcast,
  scenarioVa3FinalizeHasBoth,
];
