/**
 * Skill 桥接（L 层）。
 *
 * 把"已验证的 ReAct 轨迹"沉淀为 skill.<name> 工具，被主 ReAct 循环像调普通工具一样调用。
 * skill 内部封装一个迷你流程（固定步骤序列或子 ReAct 配置）。
 *
 * 设计意图：消除 react/dag 二元模式——一切都是工具。
 *   - 标准 OEE 诊断流程 → skill.oee_diagnose（内部 5 步序列）
 *   - 停机根因分析 → skill.downtime_root_cause
 *
 * SkillConnector 继承 FlowConnector，故注册进 ToolRegistry 后，
 * harness 的 tool-adapter 自动适配它给主 ReAct 循环，无需特殊处理。
 */
import { randomUUID } from "node:crypto";
import type { FlowConnector } from "../tools/base.js";
import type { ToolResult } from "../tools/base.js";
import type { ToolEvent } from "../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../core/stream-events.js";

/** skill 内部的单步定义。 */
export interface SkillStep {
  /** 步骤描述（用于 tool 描述 + 日志）。 */
  description: string;
  /**
   * 执行函数。
   * @param ctx       ExecutionContext（透传）
   * @param params    skill 输入参数（外层 FlowConnector.execute 的 params）
   * @param priorResults 前序步骤的结果数组
   * @returns 本步结果（追加到 priorResults）
   */
  execute: (
    ctx: Parameters<FlowConnector["execute"]>[1],
    params: Record<string, unknown>,
    priorResults: unknown[],
  ) => Promise<unknown>;
}

/**
 * SkillConnector：封装已验证流程的特殊 FlowConnector。
 *
 * 通过 kind="skill" 标识，harness/前端可识别它是沉淀流程。
 * 本体仍是 FlowConnector，故能注册进 ToolRegistry。
 *
 * status 字段标识 skill 成熟度：
 *   - "active"（缺省）：正式 skill，注册进 toolTiers，主循环直接采用结果
 *   - "draft"：试运行 skill，以影子模式运行（结果标记 _shadow，不直接采用，与主循环对比）
 *     连续 N 次与原方法结论一致、无反信号命中才转正（由 SkillRegistry 计数升级）
 */
export interface SkillConnector extends FlowConnector {
  readonly kind: "skill";
  readonly steps: SkillStep[];
  /** 成熟度：active（正式）/ draft（试运行，影子模式）。缺省 active。 */
  readonly status?: "draft" | "active";
}

/**
 * 创建一个 skill 工具。
 *
 * @param opts
 *   - name:        skill.oee_diagnose（dot-namespacing）
 *   - description: 喂给 LLM 的"何时调用此 skill"
 *   - steps:       内部步骤序列
 *   - inputSchema: skill 的输入参数（透传给第一步）
 *   - status:      active（正式，缺省）/ draft（试运行，影子模式）
 */
export function createSkill(opts: {
  name: string;
  description: string;
  whenToUse: FlowConnector["whenToUse"];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  steps: SkillStep[];
  risk?: "safe" | "write" | "destructive";
  status?: "draft" | "active";
}): SkillConnector {
  const { name, description, whenToUse, inputSchema, outputSchema, outputExample, steps, risk, status = "active" } = opts;
  const isDraft = status === "draft";

  const connector: SkillConnector = {
    kind: "skill",
    name,
    tier: "domain", // skill 注册到 domain 层（harness 默认 core+domain+custom 都给 LLM）
    description: isDraft
      ? `[Skill·draft] ${description}（封装 ${steps.length} 步标准流程，试运行中，结果标 _shadow）`
      : `[Skill] ${description}（封装 ${steps.length} 步标准流程）`,
    inputSchema,
    outputSchema,
    outputExample,
    whenToUse,
    ...(risk ? { risk } : {}),
    steps,
    status,

    async *execute(
      params: Record<string, unknown>,
      ctx: Parameters<FlowConnector["execute"]>[1],
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name,
          args: { stepCount: steps.length, ...params },
          risk: risk ?? "safe",
          groupId: ctx.nodeId,
        }),
      };

      const results: unknown[] = [];
      const errors: string[] = [];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step) continue;
        try {
          const r = await step.execute(ctx, params, results);
          results.push(r);
          // 每步发 workflow_node 事件（前端可见 skill 内部进度）
          yield {
            type: "workflow_node",
            channel: "status",
            payload: {
              run_id: ctx.runId,
              node_id: `${name}#step${i + 1}`,
              name: step.description,
              state: "done",
              started_at: startedAt,
              duration_ms: Date.now() - startedAt,
            },
          } as unknown as ToolEvent;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`步骤 ${i + 1}（${step.description}）失败：${msg}`);
          break;
        }
      }

      const lastStepResult = results.length > 0 ? results[results.length - 1] : undefined;
      const lastIsEvidence = isEvidenceLike(lastStepResult);

      // 1) 如果末步结果是 EvidenceEnvelope，则提升为 skill 的最终输出（保留信封语义），
      //    并把 skill 执行元信息注入 data._skill。
      // 2) 否则用 skill 自己的 envelope 包一层。
      const skillMeta = {
        skillName: name,
        completed: errors.length === 0,
        stepCount: results.length,
        stepResults: results,
        ...(errors.length > 0 ? { errors } : {}),
      };

      let output: Record<string, unknown>;
      if (lastIsEvidence && lastStepResult && typeof lastStepResult === "object") {
        const env = lastStepResult as {
          data: Record<string, unknown>;
          freshness?: string;
          capturedAt?: string;
          confidence?: string;
          source?: { system?: string; provenance?: string };
          caveat?: string;
        };
        output = {
          ...env,
          data: { ...env.data, _skill: skillMeta },
        };
      } else {
        output = {
          data: { stepResults: results, _skill: skillMeta },
          freshness: "realtime" as const,
          capturedAt: new Date().toISOString(),
          confidence: errors.length === 0 ? "inferred" : "estimated",
          source: { system: "skill", provenance: name },
          ...(errors.length > 0 ? { caveat: errors.join("; ") } : {}),
        };
      }

      // draft 影子模式：标记 _shadow，让主循环/前端识别"这是试运行结果，不直接采用"
      if (isDraft) {
        if (output.data && typeof output.data === "object") {
          output.data = { ...(output.data as Record<string, unknown>), _shadow: true };
        }
        output._shadow = true;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(output),
          duration_ms: Date.now() - startedAt,
        }),
      };

      return {
        output,
        summary: `skill ${name} ${errors.length === 0 ? "完成" : "部分失败"}（${results.length}/${steps.length} 步）`,
      };
    },
  };

  return connector;
}

/** 末步结果是否形如 EvidenceEnvelope（duck-typing）。 */
function isEvidenceLike(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    "data" in o &&
    "freshness" in o &&
    "capturedAt" in o &&
    "confidence" in o &&
    "source" in o
  );
}
