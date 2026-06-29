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
import { actionStore, type ActionReceipt } from "./action-store.js";

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
      execCtx?: { callId?: string },
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = execCtx?.callId ?? `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      const scenarioCtx = ctxFromArgs(args);

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

      const data = spec.getData(scenarioCtx, args);
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
        summary: `${spec.name} ${scenarioCtx.line ?? "L01"}(${scenarioCtx.scenarioId})`,
      };
    },
  };

  return connector;
}

/**
 * 动作工具构造参数。
 *
 * 与 DomainToolSpec 的区别：
 *  - name 必须是 mcp.<serverId>.<tool> 形态（governance 规则按此前缀匹配）
 *  - risk 必填（write 或 destructive），决定是否走 HITL 确认门
 *  - execute 返回 ActionReceipt（含单据号 + 副作用覆盖），而非纯数据
 *  - 系统来源是外部业务系统（MES/ERP/QMS），freshness 缺省 realtime
 */
export interface ActionToolSpec {
  /** 工具全名（如 mcp.mes.schedule_work_order）。 */
  name: string;
  /** 描述（喂给 LLM：何时用、副作用、是否需确认）。 */
  description: string;
  /** 触发场景。 */
  triggers: string[];
  /** 不适用场景。 */
  notFor: string[];
  /** 输入 schema（除 scenarioId/line 外的字段）。 */
  inputSchema: Record<string, unknown>;
  /** 风险评级（write/destructive，必填）。 */
  risk: "write" | "destructive";
  /** 执行逻辑：从参数产出执行回执（含单据号 + 副作用）。 */
  run: (args: Record<string, unknown>, ctx: ReturnType<typeof ctxFromArgs>) => ActionReceipt;
  /** 业务系统来源（MES/ERP/QMS/EHS）。 */
  system: string;
  /** provenance 描述。 */
  provenance: (args: Record<string, unknown>) => string;
  /** 单据号前缀（mock 生成 ticketId 用，如 WO/MO/QH/PM）。 */
  ticketPrefix: string;
  /** 数据时效性（缺省 realtime）。 */
  freshness?: EvidenceEnvelope["freshness"];
}

/**
 * 构造一个 NexusOps 动作工具（write/destructive，走 HITL，返回执行回执信封）。
 *
 * 与 createQueryTool 的关键差异：
 *  - risk 显式 write/destructive → tool-adapter 自动触发 requireConfirmation
 *  - 执行后记录到 actionStore，副作用覆盖可被后续读取工具观察到
 *  - 输出是 ActionReceipt（业务回执），confidence=inferred（动作结果非实测）
 */
export function createActionTool(spec: ActionToolSpec): FlowConnector {
  const connector: FlowConnector = {
    name: spec.name,
    tier: "custom",
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
      required: spec.inputSchema.required ?? [],
    },
    whenToUse: { triggers: spec.triggers, notFor: spec.notFor },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "执行回执（ticketId/status/summary/sideEffects）" },
        freshness: { type: "string" },
        capturedAt: { type: "string" },
        confidence: { type: "string" },
        source: { type: "object" },
      },
    },
    outputExample: {
      data: {
        ticketId: `${spec.ticketPrefix}-YYYYMMDD-NNN`,
        status: "executed",
        summary: "操作已执行",
      },
      freshness: spec.freshness ?? "realtime",
      capturedAt: new Date().toISOString(),
      confidence: "inferred",
      source: { system: spec.system, provenance: spec.name },
    },
    risk: spec.risk,

    async *execute(
      args: Record<string, unknown>,
      execCtx?: { callId?: string },
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = execCtx?.callId ?? `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      const scenarioCtx = ctxFromArgs(args);

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: spec.name,
          args,
          risk: spec.risk,
          groupId: spec.name.split(".").slice(0, 2).join("."),
        }),
      };

      // 注入单据号（让 run 逻辑可用），执行动作
      const receipt = spec.run(args, scenarioCtx);
      if (!receipt.ticketId) receipt.ticketId = actionStore.nextTicket(spec.ticketPrefix);

      // 记录到 store（副作用覆盖在此应用；用 scenarioCtx 解析后的 scenarioId/line 保持键一致）
      actionStore.record({
        tool: spec.name,
        args: { ...args, scenarioId: scenarioCtx.scenarioId, line: scenarioCtx.line ?? "L01" },
        executedAt: new Date().toISOString(),
        receipt,
        confirmed: true, // 能走到这里说明 HITL 已放行（或 safe 直接执行）
      });

      const envelope = mockEvidence(receipt, {
        system: spec.system,
        provenance: spec.provenance(args),
        freshness: spec.freshness ?? "realtime",
        confidence: "inferred",
        caveat: "mock 执行回执（非真实业务系统）",
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
        summary: `${spec.name} → ${receipt.ticketId}(${receipt.status})`,
      };
    },
  };

  return connector;
}

export type { ScenarioId, LineId };
