/**
 * core.knowledge_base 工具（T 层 —— 平台内置工具，查询所有 KB provider）。
 *
 * 汇总应用注册的全部 IKnowledgeProvider（Obsidian / MCP resources / 其他），
 * 按 query 检索最相关片段，结果包成 EvidenceEnvelope 统一信封。
 *
 * ReAct 主循环把此工具暴露给 LLM，LLM 用自然语言查询专有知识。
 */
import { randomUUID } from "node:crypto";
import type { FlowConnector, ToolResult, ExecutionContext } from "../base.js";
import type { ToolEvent } from "../../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../core/stream-events.js";
import { wrapEvidence } from "../../core/evidence-envelope.js";
import { narrate } from "../../core/narrate.js";
import {
  type IKnowledgeProvider,
  type KnowledgeQuery,
  wrapSnippetAsEvidence,
} from "../knowledge/provider.js";

/**
 * 工厂：构造 core.knowledge_base 工具。
 * @param providers 应用注册的全部 KB provider
 */
export function createKnowledgeBaseTool(
  providers: IKnowledgeProvider[],
): FlowConnector {
  const connector: FlowConnector = {
    name: "core.knowledge_base",
    tier: "core",
    description:
      "检索专有知识库（企业 SOP、改善案例、术语表、A3 报告等）。返回带时效/置信度标注的 EvidenceEnvelope 片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "自然语言查询（如'OEE 计算口径' / '停机根因 5Why 模板'）",
        },
        topK: {
          type: "number",
          description: "返回结果数上限（缺省 5）",
        },
        provider: {
          type: "string",
          description: "指定 provider id（缺省查全部）",
        },
      },
      required: ["query"],
    },
    whenToUse: {
      triggers: [
        "需要企业专有知识（SOP/标准/模板）",
        "查询历史改善案例或 A3 报告",
        "确认术语定义或计算口径",
        "需要专家方法论指引",
      ],
      notFor: [
        "实时生产数据（走 domain.* 查询工具查 MES）",
        "公开通用知识（走 web_search）",
        "具体 URL 内容（走 web_fetch）",
      ],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: { type: "object" },
            },
          },
        },
        freshness: { type: "string" },
        capturedAt: { type: "string" },
        confidence: { type: "string" },
        source: { type: "object" },
      },
    },
    outputExample: {
      data: {
        results: [
          { title: "OEE 计算口径", path: "01-现场状态/OEE计算口径.md", score: 5 },
        ],
        providersQueried: ["obsidian"],
      },
      freshness: "historical",
      capturedAt: new Date().toISOString(),
      confidence: "inferred",
      source: { system: "obsidian", provenance: "knowledge_base" },
    },

    async *execute(
      params: Record<string, unknown>,
      ctx: ExecutionContext,
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      const query = String(params.query ?? "");
      const topK = typeof params.topK === "number" ? params.topK : 5;
      const providerFilter = typeof params.provider === "string" ? params.provider : undefined;

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: "core.knowledge_base",
          args: { query, topK, provider: providerFilter },
          risk: "safe",
          groupId: "core.kb",
        }),
      };

      const queryObj: KnowledgeQuery = { query, topK };
      const targets = providerFilter
        ? providers.filter((p) => p.id === providerFilter)
        : providers;

      const allResults: Array<{
        provider: string;
        snippet: Awaited<ReturnType<IKnowledgeProvider["search"]>>[number];
      }> = [];
      const providersQueried: string[] = [];

      await narrate(ctx, `正在检索知识库：${query}…`);
      for (const provider of targets) {
        if (!provider.ready()) continue;
        providersQueried.push(provider.id);
        await narrate(ctx, `检索 ${provider.id}…`);
        try {
          const snippets = await provider.search(queryObj);
          for (const snippet of snippets) {
            allResults.push({ provider: provider.id, snippet });
          }
        } catch {
          // 单 provider 失败不阻塞
        }
      }
      if (allResults.length > 0) {
        await narrate(ctx, `知识库命中 ${allResults.length} 条片段。`);
      }

      // 跨 provider 合并 + 按 score 降序 + 截 topK
      allResults.sort((a, b) => (b.snippet.score ?? 0) - (a.snippet.score ?? 0));
      const top = allResults.slice(0, topK);

      // 把每个 snippet 包成 EvidenceEnvelope
      const envelopes = top.map(({ provider, snippet }) =>
        wrapSnippetAsEvidence(snippet, { system: provider }),
      );

      const aggregateData = {
        results: envelopes,
        providersQueried,
        totalHits: allResults.length,
        query,
      };

      const envelope = wrapEvidence(aggregateData, {
        freshness: "historical",
        confidence: "inferred",
        system: providersQueried[0] ?? "knowledge_base",
        provenance: `kb_search(${query})`,
        caveat: providers.length === 0 ? "无可用 KB provider" : undefined,
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
        summary: `KB 检索 "${query}" 命中 ${envelopes.length}/${allResults.length}（${providersQueried.length} providers）`,
        narration: `知识库检索完成：找到 ${envelopes.length} 条相关片段`,
      };
    },
  };

  return connector;
}
