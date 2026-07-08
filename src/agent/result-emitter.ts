/**
 * 会话收尾结果发射器（R7 钩子与摘要）。
 *
 * 把 NexusOps boot.ts:1077-1184 自实现的 emitSessionSummary / buildSessionSummary /
 * extractFinalizeSummary / countToolCalls / truncate 回归到平台层。
 *
 * 设计：
 *   - 纯函数 buildSessionSummary（可单测）+ 副作用函数 emitHarnessResult（emit 事件）
 *   - 三种 finishReason 分支：success / precondition_unmet / error
 *   - 成功路径提取 core.deliver 产物 → emit artifacts extension（用 R3 预设 helper）
 *   - emit react_result extension（用 R3 预设 helper，供前端 usage 累加）
 *
 * 与 NexusOps 自实现版本的差异：
 *   - artifacts extension 用新预设 name "artifacts"（去掉了 nexus_ 前缀，跨应用通用）
 *   - react_result 同样用预设 name
 *   - 旧 name 兼容由 meso 包 applyEvent 别名映射处理（见 docs/26-meso-packages-extension-requirements.md）
 */
import type { StepTrace, HarnessResult, EmitFn } from "./types.js";
import {
  preconditionUnmetPayload,
  artifactsPayload,
  reactResultPayload,
  type ArtifactItem,
} from "../core/extension-presets.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 会话总结输入。 */
export interface SessionSummaryInput {
  /** 终态类型。 */
  kind: "success" | "precondition_unmet" | "error";
  /** 用户原始意图。 */
  intent: string;
  /** 完整轨迹（成功路径用于提取 finalize summary；证据不足路径用于统计工具调用数）。 */
  stepTrace?: StepTrace[];
  /** LLM 已输出的最终文本（成功路径用于判定是否需补总结）。 */
  finalText?: string;
  /** nexus_finalize 工具的 summary 参数值（LLM 调 finalize 时填写的结论摘要）。 */
  finalizeSummary?: string;
  /** 停止原因（成功路径细分：finalize_tool / no_tool_call / step_count / ...）。 */
  finishReason?: string;
  /** 异常信息（error 路径）。 */
  error?: string;
}

/** emitHarnessResult 配置项。 */
export interface EmitResultOptions {
  /** 事件发射器（harness 的 emit）。 */
  emit: EmitFn;
  /** 用户原始意图。 */
  intent: string;
  /** harness 执行结果。 */
  result: HarnessResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：构造会话兜底总结文字
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造会话兜底总结文字。返回空字符串表示无需 emit。
 *
 * 三种 kind 分支：
 *   - error：emit 中断文字（截断 + 重试提示）
 *   - precondition_unmet：emit 证据不足文字（含取证次数统计）
 *   - success：LLM 已输出 ≥30 字则不补；否则用 finalize summary 或最小兜底
 */
export function buildSessionSummary(input: SessionSummaryInput): string {
  const { kind } = input;

  if (kind === "error") {
    const reason = input.error?.trim() || "未知错误";
    return `\n\n---\n分析中断：${truncate(reason, 120)}。可稍后重试。\n`;
  }

  if (kind === "precondition_unmet") {
    const toolCount = countToolCalls(input.stepTrace ?? []);
    const toolHint =
      toolCount > 0 ? `已取证 ${toolCount} 次，但关键证据仍不足。` : "尚未取证。";
    return `\n\n---\n证据不足，无法给出可靠结论。${toolHint}请补充更具体的信息（产线/设备/时间范围，或直接提供实测数据）后再分析。\n`;
  }

  // 成功路径：LLM 应已按"收尾纪律"输出完整收尾陈述
  const finalText = (input.finalText ?? "").trim();
  // LLM 已输出收尾文字 → 不补（避免重复）
  if (finalText.length >= 30) return "";

  // LLM 没输出收尾文字，但调了 nexus_finalize 并填了 summary → 用 LLM 写的 summary
  const finalizeSummary = (input.finalizeSummary ?? "").trim();
  if (finalizeSummary) {
    return `\n\n${finalizeSummary}\n`;
  }

  // 都没有（极罕见：LLM 调了工具但既没输出文字也没填 summary）→ 最小兜底
  const toolCount = countToolCalls(input.stepTrace ?? []);
  if (toolCount === 0) return ""; // 未调工具（澄清反问等），LLM 文本已 emit
  const reasonLabel = input.finishReason === "step_count" ? "（已达步数上限）" : "";
  return `\n\n---\n分析结束${reasonLabel}，但未输出总结。如需继续可追问。\n`;
}

/** 从 stepTrace 中提取 nexus_finalize 工具调用的 summary 参数值。 */
export function extractFinalizeSummary(trace: StepTrace[]): string {
  for (const step of trace) {
    for (const tc of step.toolCalls) {
      if (tc.toolName === "nexus_finalize" || tc.toolName === "nexus.finalize") {
        const summary = (tc.args as { summary?: unknown })?.summary;
        if (typeof summary === "string" && summary.trim()) return summary.trim();
      }
    }
  }
  return "";
}

/** 统计轨迹中的工具调用次数（排除被拒绝的）。 */
function countToolCalls(trace: StepTrace[]): number {
  let n = 0;
  for (const step of trace) {
    for (const tc of step.toolCalls) {
      if (!tc.rejected) n++;
    }
  }
  return n;
}

/** 把过长文本截到指定长度，超长加省略号。 */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// 副作用函数：emit harness 结果（兜底总结 + 产物 + extension）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 harness 执行结果转成 SSE 事件流。
 *
 * 三种 finishReason 分支：
 *   - error：emit text（中断文字）+ error 事件
 *   - precondition_unmet：emit text（证据不足）+ extension(precondition_unmet)
 *   - success（finalize_tool / no_tool_call / step_count / ...）：
 *       1. 提取 core.deliver 产物 → emit extension(artifacts)
 *       2. emit extension(react_result)（finishReason + stepCount + usage）
 *       3. 兜底文字（LLM 未输出时）
 *
 * 应用可在调用前后额外 emit 应用专属 extension（如 review_report / skill_candidates）。
 */
export async function emitHarnessResult(opts: EmitResultOptions): Promise<void> {
  const { emit, intent, result } = opts;
  const { finishReason } = result;

  if (finishReason === "error") {
    await emitSessionSummary(emit, {
      kind: "error",
      intent,
      error: result.error,
    });
    await emit({
      type: "error",
      channel: "meta",
      payload: { message: result.error ?? "执行出错" },
    });
    return;
  }

  if (finishReason === "precondition_unmet") {
    await emitSessionSummary(emit, {
      kind: "precondition_unmet",
      intent,
      stepTrace: result.stepTrace,
      finalText: result.finalText,
    });
    await emit({
      type: "extension",
      channel: "status",
      payload: preconditionUnmetPayload({
        finishReason: result.finishReason,
        finalText: result.finalText,
        usage: result.usage,
      }),
    });
    return;
  }

  // 成功路径
  // 1. 提取 core.deliver 产物
  const artifacts = extractArtifacts(result.stepTrace);
  if (artifacts.length > 0) {
    await emit({
      type: "extension",
      channel: "status",
      payload: artifactsPayload({ items: artifacts }),
    });
  }

  // 2. emit react_result extension
  await emit({
    type: "extension",
    channel: "status",
    payload: reactResultPayload({
      finishReason: result.finishReason,
      stepCount: result.stepTrace.length,
      usage: result.usage,
    }),
  });

  // 3. 兜底文字
  await emitSessionSummary(emit, {
    kind: "success",
    intent,
    stepTrace: result.stepTrace,
    finalText: result.finalText,
    finalizeSummary: extractFinalizeSummary(result.stepTrace),
    finishReason: result.finishReason,
  });
}

/** emit 会话总结文字（如果有）。 */
async function emitSessionSummary(emit: EmitFn, input: SessionSummaryInput): Promise<void> {
  const text = buildSessionSummary(input);
  if (!text) return;
  await emit({
    type: "text",
    channel: "content",
    payload: { delta: text },
  });
}

/**
 * 从 stepTrace 提取 core.deliver 产出的制品。
 *
 * core.deliver 的 result 可能是字符串（JSON）或对象，含 type/title/content 字段。
 *
 * id 策略（meso 2.2.0 要求 ArtifactItem.id 必填且稳定）：
 *   - 优先用 parsed.id（若 core.deliver 自带）
 *   - 否则用 `deliver-{stepNumber}-{tcId}`（基于工具调用位置，稳定且唯一）
 */
function extractArtifacts(steps: StepTrace[]): ArtifactItem[] {
  const items: ArtifactItem[] = [];
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      if (tc.toolName !== "core.deliver") continue;
      try {
        const parsed =
          typeof tc.result === "string" ? JSON.parse(tc.result) : tc.result;
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          // 稳定 id：优先用 parsed.id，否则按位置派生
          const id =
            typeof (parsed as { id?: unknown }).id === "string"
              ? String((parsed as { id: string }).id)
              : `deliver-${step.stepNumber}-${tc.id}`;
          items.push({
            id,
            type: String(parsed.type ?? "text"),
            title: String(parsed.title ?? tc.toolName),
            description: parsed.content
              ? String(parsed.content).slice(0, 80)
              : undefined,
          });
        }
      } catch {
        // 忽略解析失败
      }
    }
  }
  return items;
}
