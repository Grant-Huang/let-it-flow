/**
 * Podcast-skill e2e 场景断言（@e2e，默认排除，手动触发）。
 *
 * 不同于 NexusOps 的"真实跑 + 判官打分"模式，AI Content Factory 的 e2e 采用双层：
 *
 * 层 1（replay，确定性，无 LLM）：基于已录制 fixture 做平台机制断言
 *   - fixture 回放能正确提取工具调用链
 *   - extractToolErrors 能检测到真实错误（用含错误的合成事件验证）
 *   - 装配完整性：boot 能完成、必需工具齐全、KB provider 初始化
 *
 * 层 2（record，真实 LLM，可选）：有 OPENAI_API_KEY 时跑一次真实链路
 *   - 验证 thread_focuser 能成功（别名参数映射生效，无 schema 错）
 *   - 工具调用链包含关键节点（web_search → thread_focuser → ...）
 *   - 无 platform 引入的 tool_result 错误（web_fetch 403 等外部错误除外）
 *
 * 运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/test-podcast-e2e.ts
 */
import { describe, it, expect } from "vitest";
import {
  runPodcastFlow,
  extractCalledTools,
  extractToolErrors,
} from "./podcast-eval-harness.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import { bootAiContentFactory } from "../../apps/ai-content-factory/server/boot.js";
import { resolve } from "node:path";

const INTENT_FULL = "做一期关于 2025 年 AI Agent 技术落地的播客，方向是 Agent 在企业场景的应用，时长 15 分钟";
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const describeOrSkipRecord = hasKey ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 层 1：平台机制断言（确定性，无 LLM）
// ═══════════════════════════════════════════════════════════════════════════
describe("Podcast e2e 层 1：平台机制（replay + 装配）", () => {
  it("装配完整性：boot 注册全部必需工具 + KB provider 初始化", async () => {
    const vaultPath = resolve(process.cwd(), "apps/ai-content-factory/kb-seed/vault");
    const runtime = await bootAiContentFactory({ vaultPath });

    const names = runtime.toolRegistry.list().map((t) => t.name);
    const required = [
      "core.web_search",
      "core.web_fetch",
      "core.llm_node",
      "core.deliver",
      "core.knowledge_base",
      "skill.thread_focuser",
      "skill.write_podcast_script",
      "skill.write_wechat_article",
      "nexus_finalize",
    ];
    const missing = required.filter((n) => !names.includes(n));
    expect(missing, `装配缺失必需工具：${missing.join(", ")}`).toEqual([]);
    expect(runtime.knowledgeProviders.length, "KB provider 应初始化（obsidian）").toBeGreaterThanOrEqual(1);
  });

  it("fixture replay：能正确回放已录制的工具调用链", async () => {
    // 用已录制的完整链路 fixture（intent = AI Agent 落地）
    const result = await runPodcastFlow(INTENT_FULL, { mode: "replay" });
    // 该 fixture 至少跑了 web_search + kb + thread_focuser
    expect(result.calledTools.length, "replay 应还原工具调用链").toBeGreaterThan(0);
    expect(result.calledTools, "应含 web_search").toContain("core.web_search");
    expect(result.calledTools, "应含 thread_focuser").toContain("skill.thread_focuser");
  });

  it("extractCalledTools：从事件流按序提取 tool_call 工具名", () => {
    const events: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "core.web_search" } },
      { type: "text", channel: "content", payload: { delta: "思考" } },
      { type: "tool_call", channel: "status", payload: { id: "c2", name: "skill.thread_focuser" } },
    ] as StreamEvent[];
    expect(extractCalledTools(events)).toEqual(["core.web_search", "skill.thread_focuser"]);
  });

  it("extractToolErrors：检测 ZodError schema 错误（精确特征，不误报普通文本）", () => {
    const events: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "skill.thread_focuser" } },
      {
        type: "tool_result",
        channel: "status",
        payload: {
          tool_call_id: "c1",
          output: JSON.stringify([
            { code: "invalid_type", expected: "string", received: "undefined", path: ["prompt"], message: "Required" },
          ]),
        },
      },
    ] as StreamEvent[];
    const errs = extractToolErrors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.kind).toBe("schema_error");
    expect(errs[0]!.toolName).toBe("skill.thread_focuser");
  });

  it("extractToolErrors：不误报 KB 内容里的普通文本（术语/字数公式等）", () => {
    // KB 索引内容含"术语过滤""字数公式"等词，但不是 ZodError，不该报错
    const kbContent = "# 索引\n## 写稿铁律\n- 术语过滤：通用 vs 小众\n- 口播字数公式：分钟 × 210，±5%";
    const events: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "core.knowledge_base" } },
      {
        type: "tool_result",
        channel: "status",
        payload: { tool_call_id: "c1", output: JSON.stringify({ data: { results: [{ content: kbContent }] } }) },
      },
    ] as StreamEvent[];
    const errs = extractToolErrors(events);
    expect(errs, "KB 普通内容不应被误报为 schema_error").toEqual([]);
  });

  it("extractToolErrors：检测 skill 动态步骤失败（_skill.completed=false + errors）", () => {
    const events: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "skill.write_podcast_script" } },
      {
        type: "tool_result",
        channel: "status",
        payload: {
          tool_call_id: "c1",
          output: JSON.stringify({
            data: { stepResults: [], _skill: { skillName: "skill.write_podcast_script", completed: false, stepCount: 0, errors: ["动态步骤失败"] } },
          }),
        },
      },
    ] as StreamEvent[];
    const errs = extractToolErrors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.kind).toBe("tool_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 层 2：真实 LLM 链路（有 key 才跑）
// ═══════════════════════════════════════════════════════════════════════════
describeOrSkipRecord("Podcast e2e 层 2：真实链路（record，需 OPENAI_API_KEY）", () => {
  it(
    "thread_focuser 别名参数映射：thought 别名的 directive 被正确转成 prompt（无 schema 错）",
    async () => {
      const result = await runPodcastFlow(INTENT_FULL, { mode: "record" });

      // 链路应启动（至少有工具调用）
      expect(result.calledTools.length, "应产生工具调用").toBeGreaterThan(0);

      // 关键断言：thread_focuser 被调用时不应产生 schema_error
      // （p5 修复前 thread_focuser 因 prompt 缺失 100% 失败）
      const focuserErrors = result.toolErrors.filter(
        (e) => e.toolName === "skill.thread_focuser" && e.kind === "schema_error",
      );
      expect(
        focuserErrors,
        `thread_focuser 不应有 schema 错误（别名参数应映射），实际：${JSON.stringify(focuserErrors)}`,
      ).toEqual([]);

      // 若链路跑到了 thread_focuser，验证它被调用过
      if (result.calledTools.includes("skill.thread_focuser")) {
        const llmNodeAfterFocuser = result.calledTools.some((t) => t === "core.llm_node");
        expect(llmNodeAfterFocuser, "thread_focuser 内部应触发 core.llm_node 调用").toBe(true);
      }
    },
    300_000,
  );

  it(
    "完整链路：web_search → thread_focuser → write_podcast_script → write_wechat_article（若 LLM 跑完）",
    async () => {
      const result = await runPodcastFlow(INTENT_FULL, { mode: "record" });

      // 必经节点：搜索 + 聚焦
      expect(result.calledTools, "应调用 web_search 取证").toContain("core.web_search");
      expect(result.calledTools, "应调用 thread_focuser 聚焦").toContain("skill.thread_focuser");

      // 完整链路软断言（LLM 可能因澄清提前停，不强求）
      const hasFullChain =
        result.calledTools.includes("skill.write_podcast_script") &&
        result.calledTools.includes("skill.write_wechat_article");
      if (hasFullChain) {
        // 跑完整链路时：不应有平台引入的 schema_error（web_fetch 403 等外部错误除外）
        const platformErrors = result.toolErrors.filter(
          (e) => e.kind === "schema_error" || (e.kind === "tool_error" && !e.message.includes("HTTP")),
        );
        expect(
          platformErrors,
          `完整链路不应有平台 schema/tool 错误，实际：${JSON.stringify(platformErrors)}`,
        ).toEqual([]);
      }
    },
    300_000,
  );
});
