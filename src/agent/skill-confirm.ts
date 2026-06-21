/**
 * skill-confirm（L 层机制 —— 候选转 draft + 确认门）。
 *
 * 把 skill-miner 的候选 + sampleTrace 转成可执行的 DynamicStepsFn，调 createSkill
 * 产出 draft SkillConnector（影子模式）。确认门走 extension 事件（前端可编辑
 * name/description/steps → 回传确认）。
 *
 * 转换逻辑：sampleTrace 的工具调用序列 → toolSequenceToDynamicFn 产出一个
 * DynamicStepsFn（每步用 step() 包裹 ctx.call(toolName, params)，保留 _skillStepError
 * 降级语义）。
 *
 * 与手写 skill 统一走同一条 runDynamicSteps 执行路径。
 */
import { createSkill, type DynamicStepsFn, type SkillConnector } from "./skill-bridge.js";
import type { CandidateRecord } from "./skill-registry.js";
import type { StepTrace } from "./types.js";

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
 * 把工具序列转成 DynamicStepsFn。
 *
 * 每个工具调用包在一个 step() 里，内部走 ctx.call(toolName, params)。
 * 未注册工具不抛错（保留 _skillStepError 降级语义，让 skill 继续跑完，
 * 错误标记进入步骤结果，由 createSkill 汇总为 skillMeta）。
 *
 * skill 输入参数透传给每一步的 ctx.call。
 *
 * @param toolNames  工具名序列
 * @returns          DynamicStepsFn（供 createSkill.steps）
 */
export function toolSequenceToDynamicFn(toolNames: string[]): DynamicStepsFn {
  return async (input) => {
    const { step } = input;
    // 剥离 step() 工厂，剩下的就是 skill 输入参数
    const skillParams: Record<string, unknown> = { ...input };
    delete (skillParams as { step?: unknown }).step;

    let lastResult: unknown;
    for (const toolName of toolNames) {
      lastResult = await step(`调用 ${toolName}`, async (ctx) => {
        try {
          return await ctx.call(toolName, skillParams);
        } catch (e) {
          // 未注册/执行失败：降级标记，不中断后续步骤（与原静态版语义一致）
          return {
            _skillStepError: true,
            toolName,
            reason: e instanceof Error ? e.message : String(e),
          };
        }
      });
    }
    return lastResult;
  };
}

/**
 * 从用户确认（accept）构造一个 draft SkillConnector。
 * 内部用 toolSequenceToDynamicFn 把工具序列转成 DynamicStepsFn。
 */
export function acceptToDraftSkill(
  accept: SkillConfirmAccept,
  lookup: (name: string) => unknown,
): SkillConnector {
  void lookup; // 工具查找由运行时 ExecutionContext.resolveTool 注入，此处不静态绑定
  const dynamicSteps = toolSequenceToDynamicFn(accept.steps);
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
    steps: dynamicSteps,
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
