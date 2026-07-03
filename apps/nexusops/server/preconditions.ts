/**
 * NexusOps 业务前置条件（V 层内容 —— 应用声明，平台 PreconditionRegistry 执行）。
 *
 * 来自设计："某类任务在哪些信息被确认之前禁止进入回答阶段——比靠模型自我感知可靠得多"。
 *
 * 两类触发时机：
 *   - on_finalize：finalize 时检查（缺省）。证据不足则 finishReason=precondition_unmet。
 *   - every_step：每步检查（由 prepareStep 钩子注入提示，见 prepare-step.ts）。
 *                 让"取证不足别急着答"实时生效，而非拖到 finalize。
 *
 * 双模式支持（与 boot.ts 的 NEXUS_MOCK_TOOLS 开关对齐）：
 *   - mock 全开（缺省）：要求对应域前缀工具（oee. / equipment. 等前缀）被调用
 *   - mock 关闭取证：要求 mcp.<server>.call 或 nexus_tool_resolver 被调用过（任何 MCP 取证都算"已尝试"）
 *                     若都没调，提示走三档降级链（见 buildMockModePrompt）
 */
import { PreconditionRegistry, calledToolNames } from "../../../src/agent/precondition.js";
import type { Precondition, StepTrace } from "../../../src/agent/types.js";

/**
 * 业务域取证要求定义。
 *
 * 每个域提供两套判定：
 *   - mockHasEvidence：mock 全开模式下，要求对应域前缀工具被调用
 *   - mcpHasEvidence：关闭取证模式下，要求任意 MCP 取证工具被调用
 *                    （mcp.*.call 或 nexus_tool_resolver）
 */
interface EvidenceGateSpec {
  /** 规则 id 后缀（on_finalize / every_step 各一份）。 */
  id: string;
  /** 域名（OEE / 停机 / 质量 / ...）。 */
  domain: string;
  /** 该域相关的意图关键词（扫 thought 粗判意图）。 */
  keywords: string[];
  /** mock 全开模式下，满足取证的工具名前缀或全名判定。 */
  mockHasEvidence: (called: Set<string>) => boolean;
  /** 缺证时建议调的工具名（mock 模式）。 */
  missingTool: string;
  /** 缺证时喂给 LLM 的提示文案（自动按模式切换 mock / mcp 版本）。 */
  prompt: string;
}

// ── 10 个域的取证要求 ──────────────────────────────────────────────

const OEE_GATE: EvidenceGateSpec = {
  id: "oee_evidence",
  domain: "OEE",
  keywords: ["oee", "可用性", "表现性", "设备综合效率", "可用率", "表现指数"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("oee.")),
  missingTool: "oee.realtime",
  prompt:
    "讨论涉及 OEE，但尚未拿到 OEE 实测数据。请先取证再给结论。",
};

const EQUIPMENT_GATE: EvidenceGateSpec = {
  id: "equipment_evidence",
  domain: "设备/停机",
  keywords: ["停机", "宕机", "故障", "downtime", "mtbf", "mttr", "设备"],
  mockHasEvidence: (called) =>
    [...called].some((n) => n.startsWith("equipment.")) ||
    called.has("skill.downtime_root_cause"),
  missingTool: "equipment.downtime",
  prompt:
    "讨论涉及停机/设备故障，但尚未取证。请先取证（设备运行态/MTBF/MTTR）补齐证据。",
};

const QUALITY_GATE: EvidenceGateSpec = {
  id: "quality_evidence",
  domain: "质量",
  keywords: ["缺陷", "良率", "不良", "defect", "fpy", "cpk", "spc", "报废"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("quality.")),
  missingTool: "quality.defect_rate",
  prompt:
    "讨论涉及质量/缺陷率，但尚未取证。请先调质量域工具取证（缺陷率/SPC/Cpk）。",
};

const PROCESS_GATE: EvidenceGateSpec = {
  id: "process_evidence",
  domain: "工艺",
  keywords: ["工艺", "温度", "压力", "转速", "参数", "process", "偏差"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("process.")),
  missingTool: "process.parameters",
  prompt:
    "讨论涉及工艺参数，但尚未取证。请先调工艺域工具取证（参数实测/偏差）。",
};

const ENERGY_GATE: EvidenceGateSpec = {
  id: "energy_evidence",
  domain: "能耗",
  keywords: ["能耗", "能源", "功率", "电", "energy", "kwh"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("energy.")),
  missingTool: "energy.realtime",
  prompt:
    "讨论涉及能耗，但尚未取证。请先调能耗域工具取证（实时功率/成本）。",
};

const SCHEDULE_GATE: EvidenceGateSpec = {
  id: "schedule_evidence",
  domain: "排产",
  keywords: ["排产", "工单", "达成率", "schedule", "换模", "节拍"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("schedule.")),
  missingTool: "schedule.current",
  prompt:
    "讨论涉及排产/工单，但尚未取证。请先调度域工具取证（达成率/换模/产能）。",
};

const MATERIAL_GATE: EvidenceGateSpec = {
  id: "material_evidence",
  domain: "物料",
  keywords: ["物料", "库存", "wip", "缺料", "material", "供应链"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("material.")),
  missingTool: "material.inventory",
  prompt:
    "讨论涉及物料/库存，但尚未取证。请先调物料域工具取证（WIP/库存/缺料风险）。",
};

const PERSONNEL_GATE: EvidenceGateSpec = {
  id: "personnel_evidence",
  domain: "人员",
  keywords: ["人员", "技能", "班次", "疲劳", "考勤", "personnel"],
  mockHasEvidence: (called) => [...called].some((n) => n.startsWith("personnel.")),
  missingTool: "personnel.skill_matrix",
  prompt:
    "讨论涉及人员/班次，但尚未取证。请先调人员域工具取证（技能矩阵/班次差异）。",
};

const COST_GATE: EvidenceGateSpec = {
  id: "cost_evidence",
  domain: "成本",
  keywords: ["成本", "损失", "费用", "cost", "经济性"],
  mockHasEvidence: (called) =>
    [...called].some((n) => n.startsWith("economics.")) ||
    called.has("skill.cost_summary"),
  missingTool: "economics.cost_summary",
  prompt:
    "讨论涉及成本，但尚未取证。请先调经济性/成本工具取证（损失汇总/单位经济性）。",
};

const LEAN_GATE: EvidenceGateSpec = {
  id: "lean_evidence",
  domain: "精益",
  keywords: ["精益", "浪费", "价值流", "vsm", "lean", "改善"],
  mockHasEvidence: (called) =>
    [...called].some((n) => n.startsWith("lean.")) ||
    called.has("skill.waste_audit"),
  missingTool: "lean.waste_audit",
  prompt:
    "讨论涉及精益/七大浪费，但尚未取证。请先调精益工具取证。",
};

const ALL_GATES: EvidenceGateSpec[] = [
  OEE_GATE,
  EQUIPMENT_GATE,
  QUALITY_GATE,
  PROCESS_GATE,
  ENERGY_GATE,
  SCHEDULE_GATE,
  MATERIAL_GATE,
  PERSONNEL_GATE,
  COST_GATE,
  LEAN_GATE,
];

// ── 模式判定（与 boot.ts 的 resolveMockMode 对齐） ──────────────────

/**
 * 解析当前是否为"关闭取证"模式。
 *
 * 关闭取证 = NEXUS_MOCK_TOOLS=off 或 evidence（同 boot.ts 逻辑）。
 * 此处只读 env 做简化判定（不与 boot.ts 共享 resolveMockMode，避免循环依赖）。
 */
function isEvidenceToolsOff(): boolean {
  const raw = process.env.NEXUS_MOCK_TOOLS;
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    return v === "0" || v === "off" || v === "evidence";
  }
  return false;
}

/**
 * 关闭取证模式下的"已尝试取证"判定：
 * 任何 mcp.*.call 或 nexus_tool_resolver 被调用过都算"已尝试"。
 *
 * 设计理由：关闭模式下我们没有"oee.* 被调用"这种强信号，
 * 只能宽松判定 LLM 至少尝试过走 MCP 路径。是否真的拿到数据
 * 由 prepare-step 的语义级 EvidenceGate 兜底评估。
 */
function hasAttemptedMcpEvidence(called: Set<string>): boolean {
  return (
    [...called].some((n) => n.startsWith("mcp.")) ||
    called.has("nexus_tool_resolver")
  );
}

// ── 证据门检查 ─────────────────────────────────────────────────────

/**
 * 证据门检查：trace 里已出现收尾/建议工具（nexus_advise/nexus_finalize），
 * 且意图涉及该域，但未取证 → 未满足。
 *
 * 按当前模式（mock 全开 / 关闭取证）切换判定逻辑：
 *   - mock 全开：要求对应域前缀工具被调用
 *   - 关闭取证：要求 mcp.*.call 或 nexus_tool_resolver 被调用过
 *
 * on_finalize 与 every_step 共用同一检查逻辑，区别仅在触发时机与 harness 处理方式。
 */
function checkEvidenceGate(
  trace: StepTrace[],
  gate: EvidenceGateSpec,
): { met: true } | { met: false; missingTool: string; prompt: string } {
  const called = calledToolNames(trace);
  const hasAdvise = called.has("nexus_advise") || called.has("nexus_finalize");
  const mentionsDomain = mentions(trace, gate.keywords);
  if (!hasAdvise || !mentionsDomain) return { met: true };

  const evidenceToolsOff = isEvidenceToolsOff();
  const hasEvidence = evidenceToolsOff
    ? hasAttemptedMcpEvidence(called)
    : gate.mockHasEvidence(called);

  if (hasEvidence) return { met: true };

  // 缺证：按模式构造提示
  const prompt = evidenceToolsOff
    ? `${gate.prompt}（当前为 MCP 模式：调 nexus_tool_resolver(semantic="<语义>") 查 MCP 等价工具，再调 mcp.<server>.call 取证；找不到等价工具则反问用户或标注证据缺失）`
    : `${gate.prompt}（建议工具：${gate.missingTool}）`;

  return { met: false, missingTool: gate.missingTool, prompt };
}

/**
 * 扫描所有 every_step 型证据门，返回未满足的提示列表。
 * prepare-step.ts 调此函数，把提示注入 system 提示，让 LLM 在下一步补取证。
 */
export function collectEveryStepReminders(trace: StepTrace[]): string[] {
  const reminders: string[] = [];
  for (const gate of ALL_GATES) {
    const r = checkEvidenceGate(trace, gate);
    if (!r.met) reminders.push((r as { prompt: string }).prompt);
  }
  return reminders;
}

/**
 * 构造 NexusOps 的业务前置条件注册表。
 *
 * 注册的规则：
 *   - on_finalize 型：finalize 时检查（已有，保留向后兼容）
 *   - every_step 型：每步检查（新增，提示由 prepareStep 注入）
 */
export function buildNexusPreconditions(): PreconditionRegistry {
  const reg = new PreconditionRegistry();

  for (const gate of ALL_GATES) {
    // on_finalize 版（缺省）：finalize 时兜底检查
    reg.register({
      id: `require_${gate.id}`,
      description: `给出 ${gate.domain} 相关结论前，必须先取证（on_finalize 兜底）`,
      phase: "on_finalize",
      check: (trace) => checkEvidenceGate(trace, gate),
    } satisfies Precondition);

    // every_step 版：每步检查，提前拦截"未取证就想给建议"
    reg.register({
      id: `require_${gate.id}_early`,
      description: `涉及 ${gate.domain} 时，每步检查是否已取证（提示由 prepareStep 注入）`,
      phase: "every_step",
      check: (trace) => checkEvidenceGate(trace, gate),
    } satisfies Precondition);
  }

  return reg;
}

/** 把 preconditions 数组化（harness 直接消费）。 */
export function nexusPreconditionList(reg: PreconditionRegistry): Precondition[] {
  return reg.list();
}

/** 扫描 stepTrace 的 thought 文本是否提及任意关键词（粗判意图）。 */
function mentions(trace: StepTrace[], keywords: string[]): boolean {
  for (const step of trace) {
    const t = (step.thought ?? "").toLowerCase();
    if (keywords.some((k) => t.includes(k.toLowerCase()))) return true;
  }
  return false;
}
