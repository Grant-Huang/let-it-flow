/**
 * E 层场景（narrative）：验证 skill 执行期间产出 Claude Code 风格 text 叙述。
 *
 * 对应 docs/20-narrative-output-rules.md 的标准化输出规则。
 * 关键验证点：
 *  - skill 内每个 step 开始前/结束后都有 text 事件流出
 *  - text 事件走 content channel（可被 coalescer 合并）
 *  - narrative 文本符合规范（第一人称、动词开头、≤50 字）
 *
 * 与 e-layer.ts（fixture 回放）的区别：本场景直接跑 skill 的 dynamicSteps，
 * 不依赖 LLM fixture，用 mock ctx.call 桩掉 ctx.call 返回值，纯验证 narrative 流出。
 */
import type { Scenario } from "./types.js";
import type { ToolEvent, StreamEvent } from "../../src/core/stream-events.js";

/** 构造一个记录事件的 mock StepCtx（桩掉 call/requireConfirmation/emit）。 */
function makeMockStepCtx() {
  const events: ToolEvent[] = [];
  const ctx = {
    emit: async (event: Omit<StreamEvent, "seq" | "taskId" | "ts">) => {
      events.push(event as ToolEvent);
      return { ...event, seq: events.length, taskId: "t1", ts: Date.now() } as StreamEvent;
    },
    call: async <T = unknown>(_toolName: string, _params: Record<string, unknown>): Promise<T> => {
      // 桩：根据 toolName 返回合理结构，让 skill 能走完所有 step
      if (_toolName === "kb.search") {
        return { data: { results: [{ data: { content: "mock 铁律" } }] } } as T;
      }
      if (_toolName === "thought") {
        return {
          threads: [{ id: "t1", summary: "mock 线索", evidence: "证据", argumentSpace: 8 }],
          contentType: "rigorous",
          wordCount: 6300,
          needsRevise: false,
          violations: [],
          citations: [],
        } as T;
      }
      if (_toolName === "generate") {
        return { script: "mock 口播稿", segments: ["段一"], article: "mock 长文", sections: [{ title: "章", content: "内容" }] } as T;
      }
      return {} as T;
    },
    requireConfirmation: async () => ({ approved: true, params: { choice: "t1" } }),
    resolveRef: (_ref: string) => undefined,
    resolveTool: (_name: string) => undefined,
    taskId: "t1",
    runId: "r1",
    nodeId: "n1",
  };
  return { ctx, events };
}

/** 从事件流提取所有 text 叙述（narrative）。 */
function extractNarratives(events: ToolEvent[]): string[] {
  return events
    .filter((e) => e.type === "text")
    .map((e) => (e.payload as { delta?: string }).delta ?? "")
    .filter((d) => d.length > 0);
}

/** 校验单条 narrative 是否符合规范（≤50 字、非空）。 */
function isWellFormed(text: string): boolean {
  const clean = text.replace(/^\n/, "").trim();
  return clean.length > 0 && clean.length <= 50;
}

export const narrativeScenarios: Scenario[] = [
  {
    id: "E-N1",
    layer: "E",
    title: "narrative 规则：write_podcast_script 执行期间流出 text 叙述",
    hypothesis: "skill 内每个 step 开始前都应 emit text 叙述（Claude Code 风格），走 content channel",
    purpose: "验证 docs/20-narrative-output-rules.md 规则被 skill 实际遵守，narrative 实时流出而非静默",
    procedure: [
      "mock ctx（桩掉 call/emit），跑 writePodcastScriptSkill.dynamicSteps",
      "提取所有 text 事件 delta",
      "断言：text 事件数 ≥ 4（skill 开始 + 至少 3 个 step）",
      "断言：所有 narrative ≤ 50 字、非空",
    ],
    calls: [
      { target: "writePodcastScriptSkill.dynamicSteps", kind: "real", note: "真实 skill 逻辑（mock 掉底层工具）" },
      { target: "mock StepCtx", kind: "synthetic", note: "桩掉 call 返回值，让 skill 走完全部 step" },
    ],
    assertions: [
      { name: "text 事件数 ≥ 4（skill 开始 + 多个 step）", expected: "≥4 条 text 叙述" },
      { name: "所有 narrative 符合规范（≤50 字）", expected: "100% well-formed" },
      { name: "含 skill 开始叙述（我来…）", expected: "至少一条含「我来」" },
    ],
    async run() {
      const { writePodcastScriptSkill } = await import(
        "../../apps/ai-content-factory/skills/write-podcast-script.js"
      );
      const { ctx, events } = makeMockStepCtx();

      // 构造 stepsInput（skill 的 dynamicSteps 入参）
      const results: unknown[] = [];
      const stepsInput = {
        focusedThread: { id: "t1", summary: "AI Agent 落地" },
        narrative: "briefing",
        durationMinutes: 30,
        language: "zh",
        narrate: async (text: string) => {
          await ctx.emit({ type: "text", channel: "content", payload: { delta: text } });
        },
        narrateSummary: async (text: string) => {
          await ctx.emit({ type: "text", channel: "content", payload: { delta: `\n${text}` } });
        },
        step: async <T = unknown>(_name: string, fn: (c: typeof ctx) => Promise<T>): Promise<T> => {
          const r = await fn(ctx);
          results.push(r);
          return r;
        },
      };

      await writePodcastScriptSkill.dynamicSteps(stepsInput);
      const narratives = extractNarratives(events);

      this.assertions[0]!.actual = `${narratives.length} 条 text 叙述`;
      this.assertions[0]!.passed = narratives.length >= 4;

      const wellFormedCount = narratives.filter(isWellFormed).length;
      this.assertions[1]!.actual = `${wellFormedCount}/${narratives.length} well-formed`;
      this.assertions[1]!.passed = narratives.length > 0 && wellFormedCount === narratives.length;

      const hasStart = narratives.some((n) => n.includes("我来"));
      this.assertions[2]!.actual = hasStart ? "含「我来」开头" : "未找到";
      this.assertions[2]!.passed = hasStart;
    },
  },

  {
    id: "E-N2",
    layer: "E",
    title: "narrative 规则：thread_focuser 流出含线索数的产出摘要",
    hypothesis: "thread_focuser 列举线索后应 emit 含候选数的 text（找到 N 条候选线索）",
    purpose: "验证产出摘要叙述规则被遵守，narrative 携带结构化信息（计数）",
    procedure: [
      "mock ctx，跑 threadFocuserSkill.dynamicSteps（单线索分支，跳过 HITL）",
      "提取 text 事件",
      "断言：至少一条含「线索」关键字",
    ],
    calls: [
      { target: "threadFocuserSkill.dynamicSteps", kind: "real", note: "真实 skill 逻辑" },
      { target: "mock StepCtx", kind: "synthetic", note: "单线索分支，无需 HITL" },
    ],
    assertions: [
      { name: "narrative 含线索数信息", expected: "至少一条含「线索」" },
      { name: "text 事件数 ≥ 3（开始 + 列举 + 判断类型）", expected: "≥3 条" },
    ],
    async run() {
      const { threadFocuserSkill } = await import(
        "../../apps/ai-content-factory/skills/thread-focuser.js"
      );
      const { ctx, events } = makeMockStepCtx();

      const stepsInput = {
        sourceText: "AI Agent 技术趋势",
        durationMinutes: 30,
        narrate: async (text: string) => {
          await ctx.emit({ type: "text", channel: "content", payload: { delta: text } });
        },
        narrateSummary: async (text: string) => {
          await ctx.emit({ type: "text", channel: "content", payload: { delta: `\n${text}` } });
        },
        step: async <T = unknown>(_name: string, fn: (c: typeof ctx) => Promise<T>): Promise<T> => {
          return await fn(ctx);
        },
      };

      await threadFocuserSkill.dynamicSteps(stepsInput);
      const narratives = extractNarratives(events);

      const hasThreadInfo = narratives.some((n) => n.includes("线索"));
      this.assertions[0]!.actual = hasThreadInfo ? "含「线索」" : "未找到";
      this.assertions[0]!.passed = hasThreadInfo;

      this.assertions[1]!.actual = `${narratives.length} 条`;
      this.assertions[1]!.passed = narratives.length >= 3;
    },
  },
];
