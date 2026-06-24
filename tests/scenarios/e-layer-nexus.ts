/**
 * E 层场景（NexusOps）：端到端装配 + 错误检测（离线确定性）。
 *
 * 与 e-layer.ts（aicf E 层）对称：
 *   - aicf 的 E1/E2/E3 覆盖 podcast 流水线装配 + fixture 回放 + 错误检测
 *   - 本文件补齐 NexusOps 的端到端离线锁，此前 NexusOps 完全无 E 层场景
 *
 * 不依赖真实 LLM（与 aicf E1/E3 一致）：装配阶段不实际调用 LLM，错误检测用合成事件流。
 *
 * 对标关系：
 *   - E-N1 ← E1：装配完整性（必需工具 + KB provider 初始化）
 *   - E-N2 ← E3：错误检测（extractToolErrors 精确识别 nexus_advise 失败，不误报正常建议）
 */
import type { Scenario } from "./types.js";
import { bootNexusOps } from "../../apps/nexusops/server/boot.js";
import { extractToolErrors, extractCalledTools } from "../e2e/podcast-eval-harness.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

/** NexusOps 装配必须存在的工具（domain 取证 + 收尾 + skill + core）。 */
const REQUIRED_NEXUS_TOOLS = [
  // OEE 域（V 层 preconditions 依赖）
  "oee.realtime",
  "oee.decompose",
  // 设备域（停机诊断依赖）
  "equipment.downtime",
  // 质量域
  "quality.pareto",
  // 工艺域
  "process.parameters",
  // 收尾 + 建议（ReAct harness sentinel）
  "nexus_finalize",
  "nexus_advise",
  // core 工具（KB / 搜索 / llm / deliver）
  "core.knowledge_base",
  "core.web_search",
  "core.llm_node",
  // skill 沉淀流程（L 层）
  "skill.oee_diagnose",
];

export const scenarioEN1NexusBoot: Scenario = {
  id: "E-N1",
  layer: "E",
  title: "NexusOps 端到端装配：必需工具齐全 + mock MCP 动作工具注册",
  hypothesis: "bootNexusOps 应注册全部 domain 工具 + core 工具 + skill + nexus_finalize/advise + mock MCP 动作工具",
  purpose: "验证 NexusOps 装配完整性：取证工具池非空、收尾 sentinel 就位、skill 沉淀流程可用",
  procedure: [
    "用临时 dataDir 调 bootNexusOps（避免污染生产 data 目录）",
    "断言 toolRegistry.list() 含全部 12 个必需工具名",
    "断言 mock MCP 动作工具（mcp.mes.*）已注册（destructive/write HITL 门的前提）",
  ],
  calls: [
    { target: "bootNexusOps", kind: "real", note: "真实装配流程（createDefaultToolRegistry + registerBuiltinTools + nexus domain + skill + mock MCP actions）" },
    { target: "临时 dataDir", kind: "synthetic", note: "mkdtemp 临时目录隔离，避免污染生产 data/skills.json" },
  ],
  assertions: [
    { name: "12 个必需工具全部注册", expected: "OEE/设备/质量/工艺域 + nexus_finalize/advise + core.* + skill.oee_diagnose" },
    { name: "mock MCP 动作工具已注册", expected: "含 mcp.eam.stop_line（destructive HITL 门的前提，属 mock MCP 12 个之一）" },
  ],
  async run() {
    const dataDir = mkdtempSync(resolve(tmpdir(), "scn-en1-"));
    const prevDataDir = process.env.LIF_DATA_DIR;
    process.env.LIF_DATA_DIR = dataDir;
    try {
      const runtime = await bootNexusOps({});
      const names = runtime.toolRegistry.list().map((t) => t.name);
      const missing = REQUIRED_NEXUS_TOOLS.filter((n) => !names.includes(n));
      this.assertions[0]!.actual = `缺失：${missing.length === 0 ? "无" : missing.join(",")}`;
      this.assertions[0]!.passed = missing.length === 0;

      // mcp.eam.stop_line 是真实注册的 destructive 动作工具（停线，HITL + governance 双门）
      const hasStopLine = names.includes("mcp.eam.stop_line");
      const mcpCount = names.filter((n) => n.startsWith("mcp.")).length;
      this.assertions[1]!.actual = `含 mcp.eam.stop_line=${hasStopLine}（共 ${mcpCount} 个 mock MCP）`;
      this.assertions[1]!.passed = hasStopLine;

      runtime.mcpRouter.disconnectAll();
    } finally {
      if (prevDataDir === undefined) delete process.env.LIF_DATA_DIR;
      else process.env.LIF_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
};

export const scenarioEN2NexusErrorDetection: Scenario = {
  id: "E-N2",
  layer: "E",
  title: "NexusOps 错误检测：nexus_advise 校验失败 + 工具异常精确识别",
  hypothesis: "agent 调用 nexus_advise 但产出缺字段/越界的建议，或取证工具抛异常",
  purpose: "验证 extractToolErrors 能从事件流精确检出 nexus_advise 的校验失败（schema_error）和取证工具异常（tool_error），不误报正常建议",
  procedure: [
    "构造 nexus_advise 返回 invalid（validateAdvise 检出）的事件 → 断言 schema_error",
    "构造 oee.realtime 抛异常的事件 → 断言 tool_error",
    "对照：正常 nexus_advise 建议（合规）→ 0 个错误",
  ],
  calls: [
    { target: "extractToolErrors", kind: "real", note: "真实错误检测逻辑（与 aicf E3 同一平台基建）" },
    { target: "合成事件流", kind: "synthetic", note: "手搓 StreamEvent[]，含校验失败/工具异常/正常建议三类" },
  ],
  assertions: [
    { name: "nexus_advise 校验失败被检出", expected: "1 个 schema_error" },
    { name: "取证工具异常被检出", expected: "1 个 tool_error" },
    { name: "正常建议不误报", expected: "0 个错误" },
  ],
  async run() {
    // nexus_advise 校验失败（validateAdvise 检出缺字段 + 越界）
    const adviseFailEvents: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "nexus_advise" } },
      {
        type: "tool_result",
        channel: "status",
        payload: {
          tool_call_id: "c1",
          output: JSON.stringify([
            { code: "invalid_type", expected: "string", received: "undefined", path: ["rationale"], message: "Required" },
            { code: "too_big", maximum: 1, received: 1.5, path: ["impact"] },
          ]),
        },
      },
    ] as StreamEvent[];
    const adviseErrs = extractToolErrors(adviseFailEvents);
    this.assertions[0]!.actual = `${adviseErrs.length} 个 ${adviseErrs[0]?.kind ?? "-"}`;
    this.assertions[0]!.passed = adviseErrs.length === 1 && adviseErrs[0]!.kind === "schema_error";

    // 取证工具异常（oee.realtime 抛错）
    const toolErrorEvents: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "oee.realtime" } },
      {
        type: "tool_result",
        channel: "status",
        payload: {
          tool_call_id: "c1",
          output: JSON.stringify({ error: "MES 连接超时，oee.realtime 执行失败" }),
        },
      },
    ] as StreamEvent[];
    const toolErrs = extractToolErrors(toolErrorEvents);
    this.assertions[1]!.actual = `${toolErrs.length} 个 ${toolErrs[0]?.kind ?? "-"}`;
    this.assertions[1]!.passed = toolErrs.length === 1 && toolErrs[0]!.kind === "tool_error";

    // 正常建议（合规，不应报错）
    const okEvents: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "nexus_advise" } },
      {
        type: "tool_result",
        channel: "status",
        payload: {
          tool_call_id: "c1",
          output: JSON.stringify({
            data: {
              recommendations: [
                {
                  title: "调整主轴转速",
                  rationale: "OEE 性能率 0.72 偏低，主轴降速是主因",
                  impact: 0.8,
                  executionScore: 0.7,
                  confidence: 0.85,
                  evidenceRefs: ["oee.realtime", "process.parameters"],
                },
              ],
            },
          }),
        },
      },
    ] as StreamEvent[];
    const okErrs = extractToolErrors(okEvents);
    this.assertions[2]!.actual = `${okErrs.length} 个错误`;
    this.assertions[2]!.passed = okErrs.length === 0;
  },
};

export const scenarioEN3NexusEventExtraction: Scenario = {
  id: "E-N3",
  layer: "E",
  title: "NexusOps 事件流解析：extractCalledTools 还原取证链顺序",
  hypothesis: "ReAct 事件流含多步取证（oee → equipment → process）+ 收尾，extractCalledTools 应按序还原",
  purpose: "验证事件流解析基建对 NexusOps 工具链的还原（与 aicf E2 对称，确保端到端回放基建通用）",
  procedure: [
    "构造含 4 步取证 + nexus_advise + nexus_finalize 的事件流",
    "extractCalledTools 按序提取",
    "断言顺序与原始链一致，含 OEE 域取证 + 收尾 sentinel",
  ],
  calls: [
    { target: "extractCalledTools", kind: "real", note: "真实事件流解析（与 aicf E2 同一基建）" },
    { target: "合成事件流", kind: "synthetic", note: "手搓的 NexusOps 取证链事件" },
  ],
  assertions: [
    { name: "按序还原取证链", expected: "[oee.realtime, oee.decompose, equipment.downtime, process.parameters, nexus_advise, nexus_finalize]" },
    { name: "含 OEE 域取证", expected: "链中含 oee.realtime + oee.decompose" },
    { name: "含收尾 sentinel", expected: "链末尾含 nexus_finalize" },
  ],
  async run() {
    const events: StreamEvent[] = [
      { type: "tool_call", channel: "status", payload: { id: "c1", name: "oee.realtime" } },
      { type: "text", channel: "content", payload: { delta: "查实时 OEE" } },
      { type: "tool_call", channel: "status", payload: { id: "c2", name: "oee.decompose" } },
      { type: "tool_call", channel: "status", payload: { id: "c3", name: "equipment.downtime" } },
      { type: "tool_call", channel: "status", payload: { id: "c4", name: "process.parameters" } },
      { type: "tool_call", channel: "status", payload: { id: "c5", name: "nexus_advise" } },
      { type: "tool_call", channel: "status", payload: { id: "c6", name: "nexus_finalize" } },
    ] as StreamEvent[];
    const tools = extractCalledTools(events);
    const expected = [
      "oee.realtime",
      "oee.decompose",
      "equipment.downtime",
      "process.parameters",
      "nexus_advise",
      "nexus_finalize",
    ];
    const matchOrder = JSON.stringify(tools) === JSON.stringify(expected);
    this.assertions[0]!.actual = `实际：[${tools.join(", ")}]`;
    this.assertions[0]!.passed = matchOrder;

    const hasOee = tools.includes("oee.realtime") && tools.includes("oee.decompose");
    this.assertions[1]!.actual = `含 OEE 域=${hasOee}`;
    this.assertions[1]!.passed = hasOee;

    const hasFinalize = tools[tools.length - 1] === "nexus_finalize";
    this.assertions[2]!.actual = `末尾=${tools[tools.length - 1]}`;
    this.assertions[2]!.passed = hasFinalize;
  },
};

export const nexusELayerScenarios: Scenario[] = [
  scenarioEN1NexusBoot,
  scenarioEN2NexusErrorDetection,
  scenarioEN3NexusEventExtraction,
];
