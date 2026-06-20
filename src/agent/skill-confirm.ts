/**
 * skill-confirm（L 层机制 —— 候选转 draft + 确认门）。
 *
 * 把 skill-miner 的候选 + sampleTrace 转成可执行的 SkillStep[]，调 createSkill
 * 产出 draft SkillConnector（影子模式）。确认门走 extension 事件（前端可编辑
 * name/description/steps → 回传确认）。
 *
 * 转换逻辑：sampleTrace 的工具调用序列 → 每个工具一个 SkillStep，
 * step.execute 直接转发到 ToolRegistry 调用对应工具。
 */
import { createSkill, type SkillStep, type SkillConnector } from "./skill-bridge.js";
import type { CandidateRecord } from "./skill-registry.js";
import type { StepTrace } from "./types.js";
import type { FlowConnector, ToolResult } from "../tools/base.js";
import type { ToolEvent } from "../core/stream-events.js";

/** 确认门 payload（发给前端，用户可编辑后回传）。 */
export interface SkillConfirmPayload {
  /** 候选签名（只读，标识用）。 */
  signature: string;
  /** 建议的 skill 名（用户可改）。 */
  suggestedName: string;
  /** 建议的描述（用户可改）。 */
  suggestedDescription: string;
  /** 建议的步骤（工具名序列，用户可裁剪/重排）。 */
  suggestedSteps: string[];
  /** 命中的信号详情（供用户判断是否值得沉淀）。 */
  signals: {
    occurrences: number;
    costRatio?: number;
    successRatio?: number;
  };
}

/** 用户确认后的回传（可能含编辑）。 */
export interface SkillConfirmAccept {
  signature: string;
  name: string;
  description: string;
  steps: string[];
}

/**
 * 从候选记录构造确认门 payload（发给前端）。
 */
export function buildConfirmPayload(rec: CandidateRecord): SkillConfirmPayload {
  const tools = rec.sampleSequence;
  return {
    signature: rec.signature,
    suggestedName: suggestSkillName(tools),
    suggestedDescription: suggestDescription(tools, rec.occurrences),
    suggestedSteps: tools,
    signals: {
      occurrences: rec.occurrences,
    },
  };
}

/**
 * 从 sampleTrace 提取工具调用序列（去重连续重复，保留首次出现的参数范式）。
 */
export function extractStepSequence(trace: StepTrace[]): string[] {
  const seq: string[] = [];
  for (const step of trace) {
    for (const tc of step.toolCalls) {
      if (tc.rejected) continue;
      // 去重连续重复（如连续调两次 oee.realtime 只记一次）
      if (seq[seq.length - 1] !== tc.toolName) {
        seq.push(tc.toolName);
      }
    }
  }
  return seq;
}

/**
 * 把工具序列转成 SkillStep[]。
 * 每个 step 转发到 ToolRegistry 调对应工具，透传 params + 累积 priorResults。
 *
 * @param toolNames  工具名序列
 * @param registry   工具注册表（按名查 FlowConnector）
 */
export function toolSequenceToSteps(
  toolNames: string[],
  lookup: (name: string) => FlowConnector | undefined,
): SkillStep[] {
  return toolNames.map((toolName, i) => ({
    description: `步骤 ${i + 1}：调用 ${toolName}`,
    execute: async (ctx, params, _prior) => {
      const connector = lookup(toolName);
      if (!connector) {
        return { _skillStepError: true, toolName, reason: `工具 ${toolName} 未注册` };
      }
      // 转发调用：消费 generator，取最终 output
      const gen = connector.execute(params as Record<string, unknown>, ctx);
      let final: ToolResult | undefined;
      while (true) {
        const r = await gen.next();
        if (r.done) {
          final = r.value;
          break;
        }
        // SkillStep 不 emit 事件（避免与主循环 SSE 重复）；事件由 skill-bridge 统一发
      }
      return final?.output;
    },
  }));
}

/**
 * 从用户确认（accept）构造一个 draft SkillConnector。
 * 内部用 toolSequenceToSteps 把工具序列转成步骤。
 */
export function acceptToDraftSkill(
  accept: SkillConfirmAccept,
  lookup: (name: string) => FlowConnector | undefined,
): SkillConnector {
  const steps = toolSequenceToSteps(accept.steps, lookup);
  return createSkill({
    name: accept.name,
    description: accept.description,
    whenToUse: {
      triggers: [accept.description],
      notFor: ["单步查询（走对应 domain.* 工具）"],
    },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { data: { type: "object" } } },
    outputExample: { data: { _shadow: true } },
    steps,
    status: "draft",
  });
}

/** 从工具序列建议 skill 名（取第一个工具的域 + _auto）。 */
function suggestSkillName(tools: string[]): string {
  if (tools.length === 0) return "skill.auto";
  const first = tools[0]!;
  const domain = first.split(".")[0] ?? "auto";
  return `skill.${domain}_auto`;
}

/** 从工具序列 + 出现次数建议描述。 */
function suggestDescription(tools: string[], occurrences: number): string {
  return `自动沉淀流程（出现 ${occurrences} 次）：${tools.join(" → ")}`;
}
