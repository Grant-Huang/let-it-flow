/**
 * ToolResolver 工具（Phase 4.2）。
 *
 * 把 ToolResolver 暴露为 LLM 可调用的工具：nexus_tool_resolver。
 * LLM 输入语义需求（如 "process_capability"），返回匹配的工具名 + 参数建议。
 *
 * 设计意图：LLM 不需要记住全部工具名，按语义查找即可。
 */
import type { FlowConnector } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../src/core/stream-events.js";
import type { ToolResolver, BizContext, SemanticNeed } from "../../../src/orchestrator/types.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { randomUUID } from "node:crypto";

/** 创建 ToolResolver 工具（nexus_tool_resolver）。 */
export function createToolResolverTool(resolver: ToolResolver): FlowConnector {
  return {
    name: "nexus_tool_resolver",
    tier: "core",
    description:
      "按语义需求查找工具。输入 semantic（如 'process_capability'），返回匹配的工具名 + 参数建议 + 来源（index/llm）。" +
      "当不确定该用哪个工具时先调此工具按语义查找，而非硬记工具名。",
    uiLabel: "按语义查找工具",
    whenToUse: {
      triggers: ["找工具", "哪个工具", "按语义查工具", "tool resolver"],
      notFor: ["已知工具名直接调用（无需先查）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        semantic: { type: "string", description: "语义需求标识（如 process_capability / oee_metric / defect_rate）" },
        description: { type: "string", description: "可选：需求详细描述（帮助 LLM 档精确匹配）" },
        line: { type: "string", description: "产线（缺省 L01）" },
      },
      required: ["semantic"],
    },
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" }, confidence: { type: "string" } },
    },
    async *execute(args) {
      const callId = randomUUID();
      const startedAt = Date.now();
      const params = args as { semantic?: string; description?: string; line?: string };

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({ id: callId, name: "nexus_tool_resolver", args: params, risk: "safe", groupId: "nexus" }),
      } as ToolEvent;

      const semantic = String(params.semantic ?? "");
      const description = typeof params.description === "string" ? params.description : undefined;
      const line = typeof params.line === "string" ? params.line : undefined;

      let output: Record<string, unknown>;
      let confidence: "verified" | "inferred";
      let provenance = "nexus_tool_resolver";

      if (!semantic) {
        output = { error: "semantic 不能为空", resolved: null };
        confidence = "verified";
      } else {
        const need: SemanticNeed = { semantic, description };
        const ctx: BizContext = { line, scenarioId: undefined };
        try {
          const resolved = await resolver.resolve(need, ctx);
          if (!resolved) {
            output = { resolved: null, semantic, message: `未找到匹配 "${semantic}" 的工具` };
            confidence = "inferred";
          } else {
            output = {
              resolved: {
                toolName: resolved.toolName,
                params: resolved.params,
                ...(resolved.fieldMap ? { fieldMap: resolved.fieldMap } : {}),
                source: resolved.source,
                confidence: resolved.confidence,
              },
              semantic,
            };
            confidence = resolved.source === "index" ? "verified" : "inferred";
            provenance = `nexus_tool_resolver?semantic=${semantic}`;
          }
        } catch (e) {
          output = { error: e instanceof Error ? e.message : String(e), resolved: null };
          confidence = "inferred";
        }
      }

      const envelope = wrapEvidence(output, {
        freshness: "realtime",
        confidence,
        system: "internal",
        provenance,
      });

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(envelope), duration_ms: Date.now() - startedAt }),
      } as ToolEvent;

      return { output: envelope, summary: `工具解析：${semantic || "(空)"}` };
    },
  };
}
