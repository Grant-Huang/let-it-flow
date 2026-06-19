/**
 * NexusOps 工具构造 helper（应用层 —— T 内容）。
 *
 * 消费应用工具共享的构造模式：
 *   - 输入统一接受 scenarioId + line（控制 mock 场景）
 *   - 输出统一是 EvidenceEnvelope（mock 数据 → 实测证据）
 *   - 执行：发 tool_call → 取数 → 包信封 → 发 tool_result
 */
import { randomUUID } from "node:crypto";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";
import type { ToolEvent } from "../../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../../src/core/stream-events.js";
import type { EvidenceEnvelope } from "../../../../src/core/evidence-envelope.js";
import {
  type ScenarioId,
  type LineId,
  ctxFromArgs,
  mockEvidence,
} from "./scenarios.js";

/** 工具构造参数。 */
export interface DomainToolSpec<TData> {
  /** 工具名（如 oee.realtime）。 */
  name: string;
  /** 描述（喂给 LLM 选工具）。 */
  description: string;
  /** 触发场景。 */
  triggers: string[];
  /** 不适用场景。 */
  notFor: string[];
  /** 输入 schema（除 scenarioId/line 外的字段）。 */
  inputSchema: Record<string, unknown>;
  /** 取数函数：从场景上下文产出数据。 */
  getData: (ctx: ReturnType<typeof ctxFromArgs>, args: Record<string, unknown>) => TData;
  /** 数据来源系统（MES/MOM/ERP/PLM/EHS）。 */
  system: string;
  /** provenance 描述（含查询参数）。 */
  provenance: (args: Record<string, unknown>) => string;
  /** 时效性（缺省 realtime）。 */
  freshness?: EvidenceEnvelope["freshness"];
  /** 置信度（缺省 measured；预测/推断类工具设 estimated/inferred）。 */
  confidence?: EvidenceEnvelope["confidence"];
  /** 数据注意事项（如采样率）。 */
  caveat?: string;
  /** 风险评级（查询工具缺省 safe，操作工具显式 write/destructive）。 */
  risk?: "safe" | "write" | "destructive";
}

/**
 * 构造一个标准的 NexusOps 查询类工具（返回 EvidenceEnvelope）。
 */
export function createQueryTool<TData>(spec: DomainToolSpec<TData>): FlowConnector {
  const connector: FlowConnector = {
    name: spec.name,
    tier: "domain",
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: {
        scenarioId: {
          type: "string",
          enum: ["normal", "anomaly", "crisis"],
          description: "场景 id（缺省 anomaly）",
        },
        line: {
          type: "string",
          enum: ["L01", "L02", "L03"],
          description: "产线 id（缺省 L01）",
        },
        ...(spec.inputSchema.properties as Record<string, unknown>),
      },
      required: [],
    },
    whenToUse: { triggers: spec.triggers, notFor: spec.notFor },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object" },
        freshness: { type: "string" },
        capturedAt: { type: "string" },
        confidence: { type: "string" },
        source: { type: "object" },
        caveat: { type: "string" },
      },
    },
    outputExample: {
      data: {} as Record<string, unknown>,
      freshness: spec.freshness ?? "realtime",
      capturedAt: new Date().toISOString(),
      confidence: "measured",
      source: { system: spec.system, provenance: spec.name },
    },
    ...(spec.risk ? { risk: spec.risk } : {}),

    async *execute(
      args: Record<string, unknown>,
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      const ctx = ctxFromArgs(args);

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: spec.name,
          args,
          risk: spec.risk ?? "safe",
          groupId: spec.name.split(".")[0],
        }),
      };

      const data = spec.getData(ctx, args);
      const envelope = mockEvidence(data, {
        system: spec.system,
        provenance: spec.provenance(args),
        freshness: spec.freshness,
        confidence: spec.confidence,
        caveat: spec.caveat,
      });

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(envelope),
          duration_ms: Date.now() - startedAt,
        }),
      };

      return {
        output: envelope,
        summary: `${spec.name} ${ctx.line ?? "L01"}(${ctx.scenarioId})`,
      };
    },
  };

  return connector;
}

export type { ScenarioId, LineId };
