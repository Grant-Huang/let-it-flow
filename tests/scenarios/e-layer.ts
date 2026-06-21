/**
 * E 层场景：端到端 fixture 回放（AI Content Factory）。
 *
 * 与 V/G/C/L/T 层（纯函数离线验证）的区别：E 层回放真实录制的 ReAct 全流程 fixture，
 * 验证"平台机制在端到端层面的表现"——工具调用链、tool_result 错误检测、装配完整性。
 *
 * fixture 来源：tests/e2e/run-podcast-record.ts 录制（真实 LLM 跑出的 calledTools/toolErrors）。
 * 回放是确定性的（不重跑 LLM），符合 scenarios 离线报告的承诺。
 *
 * 关键价值：锁定 p5 修复的 5 个平台 bug 不回归：
 *   - 别名参数映射（thought.directive → core.llm_node.prompt）
 *   - stepTrace 丢失（boot precondition 分支不发 react_step_trace）
 *   - finalize 工具名转换（keyToName 精确映射，nexus_finalize 不被误转为 nexus.finalize）
 *   - kb 结果结构解析（data.results[].data.content）
 *   - 澄清反问误判（空 trace + 有文本 → no_tool_call，非 precondition_unmet）
 */
import type { Scenario } from "./types.js";
import { runPodcastFlow, extractCalledTools, extractToolErrors } from "../e2e/podcast-eval-harness.js";
import { bootAiContentFactory } from "../../apps/ai-content-factory/server/boot.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import { resolve } from "node:path";

const INTENT_FULL =
  "做一期关于 2025 年 AI Agent 技术落地的播客，方向是 Agent 在企业场景的应用，时长 15 分钟";

export const eLayerScenarios: Scenario[] = [
  {
    id: "E1",
    layer: "E",
    title: "端到端装配：ai-content-factory 必需工具齐全 + KB 初始化",
    hypothesis: "bootAiContentFactory 应注册全部 9 个必需工具并初始化 obsidian KB provider",
    purpose: "验证 p3 装配修复后，工具池非空、core.*/skill.*/nexus_finalize/kb 全部就位",
    procedure: [
      "调 bootAiContentFactory（注入 ai-content-factory kb-seed/vault）",
      "断言 toolRegistry.list() 含 9 个必需工具名",
      "断言 knowledgeProviders.length ≥ 1（obsidian）",
    ],
    calls: [
      { target: "bootAiContentFactory", kind: "real", note: "真实装配流程（createDefaultToolRegistry + registerBuiltinTools + skill 注册 + ObsidianProvider init）" },
      { target: "kb-seed/vault", kind: "real", note: "真实 obsidian vault 读取（仓库内的种子文件）" },
    ],
    assertions: [
      { name: "9 个必需工具全部注册", expected: "core.web_search/core.web_fetch/core.llm_node/core.deliver/core.knowledge_base + 3 个 skill + nexus_finalize" },
      { name: "KB provider 初始化", expected: "knowledgeProviders.length ≥ 1" },
    ],
    async run() {
      const vaultPath = resolve(process.cwd(), "apps/ai-content-factory/kb-seed/vault");
      const runtime = await bootAiContentFactory({ vaultPath });
      const names = runtime.toolRegistry.list().map((t) => t.name);
      const required = [
        "core.web_search", "core.web_fetch", "core.llm_node", "core.deliver",
        "core.knowledge_base", "skill.thread_focuser", "skill.write_podcast_script",
        "skill.write_wechat_article", "nexus_finalize",
      ];
      const missing = required.filter((n) => !names.includes(n));
      this.assertions[0]!.actual = `缺失：${missing.length === 0 ? "无" : missing.join(",")}`;
      this.assertions[0]!.passed = missing.length === 0;

      this.assertions[1]!.actual = `providers=${runtime.knowledgeProviders.length}`;
      this.assertions[1]!.passed = runtime.knowledgeProviders.length >= 1;
    },
  },

  {
    id: "E2",
    layer: "E",
    title: "端到端回放：fixture 工具调用链含 web_search + thread_focuser",
    hypothesis: "录制的真实 ReAct fixture 应还原完整工具调用链（搜索 → KB → 聚焦）",
    purpose: "验证 runPodcastFlow replay 模式能正确回放 calledTools，且链路包含关键节点",
    procedure: [
      `runPodcastFlow("${INTENT_FULL.slice(0, 20)}...", mode=replay)`,
      "断言 calledTools 含 core.web_search（取证）",
      "断言 calledTools 含 skill.thread_focuser（聚焦）",
    ],
    calls: [
      { target: "runPodcastFlow(replay)", kind: "real", note: "真实回放逻辑（读 fixture JSON + 还原结构）" },
      { target: "fixture 数据", kind: "synthetic", note: "录制时真实 LLM 产出的 calledTools 快照（p5 修复后录制）" },
    ],
    assertions: [
      { name: "调用链含 web_search", expected: "calledTools 包含 core.web_search" },
      { name: "调用链含 thread_focuser", expected: "calledTools 包含 skill.thread_focuser" },
    ],
    async run() {
      const result = await runPodcastFlow(INTENT_FULL, { mode: "replay" });
      this.assertions[0]!.actual = `含 web_search: ${result.calledTools.includes("core.web_search")}`;
      this.assertions[0]!.passed = result.calledTools.includes("core.web_search");
      this.assertions[1]!.actual = `含 thread_focuser: ${result.calledTools.includes("skill.thread_focuser")}`;
      this.assertions[1]!.passed = result.calledTools.includes("skill.thread_focuser");
    },
  },

  {
    id: "E3",
    layer: "E",
    title: "端到端错误检测：extractToolErrors 精确识别 schema 错（不误报 KB 文本）",
    hypothesis: "extractToolErrors 应检测真实 ZodError，但不把 KB 内容里的普通文本误报为错误",
    purpose: "锁定 p5 修复：正则收紧后，KB 索引文本（术语/字数公式）不再触发误报",
    procedure: [
      "构造含 ZodError 的 tool_result 事件，断言检出 schema_error",
      "构造含 KB 索引文本的 tool_result 事件，断言不报错",
      "构造含 _skill.completed=false 的 tool_result，断言检出 tool_error",
    ],
    calls: [
      { target: "extractToolErrors", kind: "real", note: "真实错误检测逻辑（p5 收紧的正则）" },
      { target: "合成事件流", kind: "synthetic", note: "手搓 StreamEvent[]，含 ZodError/KB/失败 skill 三类" },
    ],
    assertions: [
      { name: "ZodError 被检出为 schema_error", expected: "1 个 schema_error" },
      { name: "KB 普通文本不被误报", expected: "0 个错误" },
      { name: "skill 失败被检出为 tool_error", expected: "1 个 tool_error" },
    ],
    async run() {
      // ZodError 事件
      const zodEvents: StreamEvent[] = [
        { type: "tool_call", channel: "status", payload: { id: "c1", name: "skill.x" } },
        { type: "tool_result", channel: "status", payload: { tool_call_id: "c1", output: JSON.stringify([{ code: "invalid_type", expected: "string", received: "undefined", path: ["prompt"] }]) } },
      ] as StreamEvent[];
      const zodErrs = extractToolErrors(zodEvents);
      this.assertions[0]!.actual = `${zodErrs.length} 个 ${zodErrs[0]?.kind ?? "-"}`;
      this.assertions[0]!.passed = zodErrs.length === 1 && zodErrs[0]!.kind === "schema_error";

      // KB 文本事件（不应报错）
      const kbEvents: StreamEvent[] = [
        { type: "tool_call", channel: "status", payload: { id: "c1", name: "core.knowledge_base" } },
        { type: "tool_result", channel: "status", payload: { tool_call_id: "c1", output: JSON.stringify({ data: { results: [{ content: "术语过滤 / 口播字数公式 / 单句长度" }] } }) } },
      ] as StreamEvent[];
      const kbErrs = extractToolErrors(kbEvents);
      this.assertions[1]!.actual = `${kbErrs.length} 个错误`;
      this.assertions[1]!.passed = kbErrs.length === 0;

      // skill 失败事件
      const failEvents: StreamEvent[] = [
        { type: "tool_call", channel: "status", payload: { id: "c1", name: "skill.write_podcast_script" } },
        { type: "tool_result", channel: "status", payload: { tool_call_id: "c1", output: JSON.stringify({ data: { _skill: { completed: false, errors: ["动态步骤失败"] } } }) } },
      ] as StreamEvent[];
      const failErrs = extractToolErrors(failEvents);
      this.assertions[2]!.actual = `${failErrs.length} 个 ${failErrs[0]?.kind ?? "-"}`;
      this.assertions[2]!.passed = failErrs.length === 1 && failErrs[0]!.kind === "tool_error";
    },
  },
];
