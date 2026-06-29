/**
 * NexusOps 工具集聚合入口（应用层 —— T 内容）。
 *
 * 汇总全部业务域工具 + 两个收尾工具（nexus_finalize / nexus_advise）：
 *   - nexus_finalize：ReAct 收尾 sentinel，harness 的 stopWhen 检测此工具调用即终止循环
 *   - nexus_advise：产出结构化建议（含 impact/confidence/executionScore/action），供前端渲染建议卡
 *
 * 应用 boot.ts 调用 registerNexusTools(registry) 一次性注册全部工具。
 */
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../src/core/stream-events.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { randomUUID } from "node:crypto";
import { validateAdvise } from "./advise-validator.js";
import { registerOeeTools } from "./domains/oee.js";
import { registerEquipmentTools } from "./domains/equipment.js";
import { registerQualityTools } from "./domains/quality.js";
import { registerProcessTools } from "./domains/process.js";
import { registerEnergyTools } from "./domains/energy.js";
import { registerScheduleTools } from "./domains/scheduling.js";
import { registerMaterialTools } from "./domains/material.js";
import { registerPersonnelTools } from "./domains/personnel.js";

/**
 * 注册全部 NexusOps 业务工具到 ToolRegistry。
 * @returns 工具总数（含 finalize + advise）
 */
export function buildNexusTools(): FlowConnector[] {
  return [
    ...registerOeeTools(),
    ...registerEquipmentTools(),
    ...registerQualityTools(),
    ...registerProcessTools(),
    ...registerEnergyTools(),
    ...registerScheduleTools(),
    ...registerMaterialTools(),
    ...registerPersonnelTools(),
    createFinalizeTool(),
    createAdviseTool(),
  ];
}

/** nexus_finalize：收尾 sentinel 工具（harness stopWhen 检测）。 */
function createFinalizeTool(): FlowConnector {
  return {
    name: "nexus_finalize",
    tier: "core",
    description:
      "收尾工具。当分析完成且证据充分（满足前置条件）时调用此工具结束 ReAct 循环。不要在证据不足时调用。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "本次分析的总体结论摘要" },
      },
      required: ["summary"],
    },
    whenToUse: {
      triggers: ["分析完成", "证据充分", "可以收尾", "已经回答了用户问题"],
      notFor: ["证据不足（继续调其他工具取证）", "还有未解的子问题"],
    },
    outputSchema: { type: "object", properties: { finalized: { type: "boolean" } } },
    outputExample: { finalized: true },
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({ id: callId, name: "nexus_finalize", args: params, risk: "safe", groupId: "nexus" }),
      };
      const output = { finalized: true, summary: params.summary };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(output), duration_ms: 0 }),
      };
      return { output, summary: "ReAct 收尾" };
    },
  };
}

/** nexus_advise：产出结构化建议（前端渲染建议卡 + 行动按钮）。 */
function createAdviseTool(): FlowConnector {
  return {
    name: "nexus_advise",
    tier: "core",
    description:
      "产出结构化运营建议。基于已收集的证据（EvidenceEnvelope）给出可执行建议，含影响度/执行度/置信度。建议应配行动按钮（如能配合 MCP 执行则附 actionTool，否则仅建议）。",
    inputSchema: {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          description: "建议列表",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "建议标题" },
              rationale: { type: "string", description: "依据（引用哪些证据）" },
              impact: { type: "number", description: "影响度 0-1（解决该问题对 OEE/成本的提升幅度）" },
              executionScore: { type: "number", description: "执行度 0-1（实施难度倒数，越高越易执行）" },
              confidence: { type: "number", description: "置信度 0-1（基于证据强度）" },
              actionTool: { type: "string", description: "可选：可执行的 MCP/工具名（如 mcp.mes.update_schedule），无则留空" },
              actionArgs: { type: "object", description: "可选：actionTool 的预设参数" },
              evidenceRefs: { type: "array", items: { type: "string" }, description: "支撑证据的工具名/来源引用" },
            },
            required: ["title", "rationale", "impact", "executionScore", "confidence"],
          },
        },
      },
      required: ["recommendations"],
    },
    whenToUse: {
      triggers: ["给建议", "提改进建议", "推荐方案", "应该怎么做", "改善建议"],
      notFor: ["只取数据不分析（用 domain.* 查询）", "证据不足时硬给建议（先补证据）"],
    },
    outputSchema: { type: "object", properties: { data: { type: "object" }, confidence: { type: "string" } } },
    outputExample: {
      data: {
        recommendations: [
          {
            title: "校准温度参数至标准值",
            rationale: "工艺温度偏差 +6.5%（实测 197℃ vs 标准 185℃），是质量缺陷主因",
            impact: 0.8,
            executionScore: 0.9,
            confidence: 0.85,
            actionTool: "",
          },
        ],
      },
      confidence: "inferred",
    },
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({ id: callId, name: "nexus_advise", args: params, risk: "safe", groupId: "nexus" }),
      };
      const recs = (params.recommendations as unknown[]) ?? [];

      // B3：输出结构自检（确定性约束）。不达标则返回 invalid，LLM 被迫修正
      const validation = validateAdvise(recs);
      if (!validation.valid) {
        const invalidOutput = {
          invalid: true,
          reasons: validation.reasons,
          hint: "请按 schema 修正上述问题后重新调用 nexus_advise（impact/executionScore/confidence 必须在 [0,1]，title/rationale 必填非空）",
        };
        yield {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(invalidOutput), duration_ms: Date.now() - startedAt }),
        };
        return { output: invalidOutput, summary: `建议结构校验未通过（${validation.reasons.length} 项问题）` };
      }

      // 校验通过：把建议包成 EvidenceEnvelope（advice 类证据 confidence=inferred）
      // evidenceRefs 缺失的 warn 并入 caveat（LLM 下次产出时可见）
      const caveatParts = ["建议由 LLM 基于证据综合生成，行动前需人工复核"];
      if (validation.evidenceRefWarnings.length > 0) {
        caveatParts.push(`证据引用提醒：${validation.evidenceRefWarnings.join("；")}`);
      }
      const envelope = wrapEvidence(
        { recommendations: recs, count: recs.length },
        {
          freshness: "realtime",
          confidence: "inferred",
          system: "llm",
          provenance: "nexus_advise",
          caveat: caveatParts.join(" | "),
        },
      );
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(envelope), duration_ms: Date.now() - startedAt }),
      };
      // 同时 emit 一个 extension 事件，前端可专门监听渲染建议卡
      yield {
        type: "extension",
        channel: "artifact",
        payload: {
          name: "nexus_recommendations",
          data: { recommendations: recs },
        },
      } as unknown as ToolEvent;
      return { output: envelope, summary: `产出 ${recs.length} 条建议` };
    },
  };
}
