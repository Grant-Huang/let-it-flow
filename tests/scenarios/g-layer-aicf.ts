/**
 * G 层场景（AI Content Factory）：治理 —— 可信度保障。
 *
 * 与 g-layer.ts（NexusOps G 层）的区别：
 *   - 验证 apps/ai-content-factory/server/governance.ts 的 web_fetch 守卫。
 *   - 这组规则正是用户最初遇到 "web_fetch 需要 urls 或 fromInputRefs 至少其一非空"
 *     错误的根源，此前无离线场景锁。
 *
 * 两条规则（同 id=web_fetch_empty_urls_guard 内分支）：
 *   1. urls 和 fromInputRefs 都空 → 阻断
 *   2. urls 数量超 maxUrls（默认 5）→ 阻断
 *   对照：
 *   3. 仅 fromInputRefs 非空 → 放行（真实抓取链路）
 *   4. 非 web_fetch 工具 → 不受影响
 */
import type { Scenario } from "./types.js";
import { buildAiContentFactoryGovernance } from "../../apps/ai-content-factory/server/governance.js";

export const scenarioGa1EmptyWebFetch: Scenario = {
  id: "G-A1",
  layer: "G",
  title: "aicf：web_fetch 无 urls 无 fromInputRefs → 阻断",
  hypothesis: "agent 调用 core.web_fetch，但 urls 和 fromInputRefs 都没提供",
  purpose: "验证 web_fetch_empty_urls_guard 规则在双空时阻断，返回 allow=false + reason",
  procedure: [
    "加载 buildAiContentFactoryGovernance()",
    "调 preToolUse('core.web_fetch', { urls: [], fromInputRefs: [] }, 'safe')",
    "断言 allow=false 且 reason 含'urls 或 fromInputRefs'",
    "对照：仅 fromInputRefs 非空 → allow=true",
  ],
  calls: [
    { target: "buildAiContentFactoryGovernance / preToolUse", kind: "real", note: "真实 aicf 治理链（web_fetch 守卫）" },
    { target: "core.web_fetch 调用入参", kind: "synthetic", note: "构造的双空入参，工具未真实执行（被治理层阻断在执行前）" },
  ],
  assertions: [
    {
      name: "双空 → 阻断",
      expected: "allow=false, reason 含 'urls 或 fromInputRefs'",
    },
    {
      name: "仅 fromInputRefs 非空 → 放行",
      expected: "allow=true（真实抓取链路走 inputRefs）",
    },
  ],
  async run() {
    const chain = buildAiContentFactoryGovernance();

    const r1 = chain.preToolUse("core.web_fetch", { urls: [], fromInputRefs: [] }, "safe");
    const reason = !r1.allow ? r1.reason : "";
    const hasReason = reason.includes("urls") && reason.includes("fromInputRefs");
    this.assertions[0]!.actual = `allow=${r1.allow}, reason='${reason}'`;
    this.assertions[0]!.passed = r1.allow === false && hasReason;

    const r2 = chain.preToolUse(
      "core.web_fetch",
      { urls: [], fromInputRefs: ["$.tasks.search.output"] },
      "safe",
    );
    this.assertions[1]!.actual = `仅 fromInputRefs 非空 → allow=${r2.allow}`;
    this.assertions[1]!.passed = r2.allow === true;
  },
};

export const scenarioGa2WebFetchUrlLimit: Scenario = {
  id: "G-A2",
  layer: "G",
  title: "aicf：web_fetch 单次 URL 数超上限 → 阻断",
  hypothesis: "agent 单次 web_fetch 传入 8 个 URL（超过默认上限 5）",
  purpose: "验证 web_fetch_empty_urls_guard 的 URL 数上限分支：超 maxUrls 时阻断，避免抓取成本失控",
  procedure: [
    "加载 buildAiContentFactoryGovernance()（默认 maxUrls=5）",
    "调 preToolUse 传 8 个 URL → 断言 allow=false 且 reason 含'超过上限'",
    "对照：3 个 URL → allow=true",
    "对照：自定义 maxUrls=3 + 5 个 URL → allow=false（验证配置生效）",
  ],
  calls: [
    { target: "buildAiContentFactoryGovernance / preToolUse", kind: "real", note: "真实 aicf URL 数上限规则 + 自定义配置生效" },
    { target: "core.web_fetch 调用入参", kind: "synthetic", note: "构造的超限 URL 数组" },
  ],
  assertions: [
    {
      name: "默认上限 5 → 8 URL 阻断",
      expected: "allow=false, reason 含 '超过上限'",
    },
    {
      name: "3 URL 放行",
      expected: "allow=true（未超默认 5）",
    },
    {
      name: "自定义 maxUrls=3 生效",
      expected: "config.webFetchMaxUrlPerCall=3 + 5 URL → allow=false",
    },
  ],
  async run() {
    const chain = buildAiContentFactoryGovernance();
    const urls8 = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);

    const r1 = chain.preToolUse("core.web_fetch", { urls: urls8 }, "safe");
    const reason1 = !r1.allow ? r1.reason : "";
    this.assertions[0]!.actual = `8 URL → allow=${r1.allow}, reason='${reason1}'`;
    this.assertions[0]!.passed = r1.allow === false && reason1.includes("超过上限");

    const urls3 = urls8.slice(0, 3);
    const r2 = chain.preToolUse("core.web_fetch", { urls: urls3 }, "safe");
    this.assertions[1]!.actual = `3 URL → allow=${r2.allow}`;
    this.assertions[1]!.passed = r2.allow === true;

    const chainCustom = buildAiContentFactoryGovernance({ webFetchMaxUrlPerCall: 3 });
    const urls5 = urls8.slice(0, 5);
    const r3 = chainCustom.preToolUse("core.web_fetch", { urls: urls5 }, "safe");
    this.assertions[2]!.actual = `maxUrls=3 + 5 URL → allow=${r3.allow}`;
    this.assertions[2]!.passed = r3.allow === false;
  },
};

export const scenarioGa3NonWebFetchUnaffected: Scenario = {
  id: "G-A3",
  layer: "G",
  title: "aicf：非 web_fetch 工具不受守卫影响",
  hypothesis: "agent 调用 core.web_search / core.llm_node / skill.* 等非 web_fetch 工具",
  purpose: "验证 web_fetch_empty_urls_guard 规则对非 web_fetch 工具直接放行，不误伤其它工具",
  procedure: [
    "加载 buildAiContentFactoryGovernance()",
    "对 core.web_search / core.llm_node / skill.thread_focuser 分别调 preToolUse",
    "断言全部 allow=true",
  ],
  calls: [
    { target: "buildAiContentFactoryGovernance / preToolUse", kind: "real", note: "真实规则短路逻辑（非 web_fetch 早退放行）" },
    { target: "非 web_fetch 工具入参", kind: "synthetic", note: "构造的查询/prompt 入参" },
  ],
  assertions: [
    {
      name: "非 web_fetch 工具全部放行",
      expected: "web_search / llm_node / thread_focuser 均 allow=true",
    },
  ],
  async run() {
    const chain = buildAiContentFactoryGovernance();
    const cases: Array<{ name: string; args: unknown; risk: "safe" | "write" | "destructive" }> = [
      { name: "core.web_search", args: { query: "AI Agent" }, risk: "safe" },
      { name: "core.llm_node", args: { prompt: "总结" }, risk: "safe" },
      { name: "skill.thread_focuser", args: { directive: "聚焦" }, risk: "safe" },
    ];
    const results = cases.map((c) => ({
      name: c.name,
      allow: chain.preToolUse(c.name, c.args, c.risk).allow,
    }));
    const allAllow = results.every((r) => r.allow === true);
    this.assertions[0]!.actual = results.map((r) => `${r.name}=${r.allow}`).join(", ");
    this.assertions[0]!.passed = allAllow;
  },
};

export const aicfGLayerScenarios: Scenario[] = [
  scenarioGa1EmptyWebFetch,
  scenarioGa2WebFetchUrlLimit,
  scenarioGa3NonWebFetchUnaffected,
];
