/**
 * let-it-flow 装配层入口（runtime barrel）。
 *
 * 与主入口（src/index.ts，SDK 用户视角）的区别：
 *   - 主入口：给"我只想 `new LetItFlow()` 跑起来"的用户
 *   - runtime：给"我要拿平台零件自己拼一个服务"的装配者（如 nexusops / ai-content-factory）
 *
 * 通过子路径 `@meso.ai/let-it-flow/runtime` 暴露，避免污染 SDK 主入口的公共面。
 *
 * 用法：
 * ```ts
 * import { runReactHarness, ToolRegistry, LlmService } from "@meso.ai/let-it-flow/runtime";
 * ```
 *
 * 装配视角分组（ETCLOVG）：
 *   - Execute（执行循环）
 *   - Tools（工具生态）
 *   - Context（上下文/知识库）
 *   - LLM（模型服务）
 *   - Orchestrator（编排/解析器）
 *   - Verify（前置条件/HITL）
 *   - Governance（治理规则）
 *   - Tasks（任务运行时）
 *   - Core（核心/事件）
 */
import "dotenv/config";

// ── Execute（执行循环：ReAct harness + 评审 + 轨迹压缩）──────────────────────────
export { runReactHarness } from "./agent/react-harness.js";
export { runReviewPass, compressTrace } from "./agent/review-pass.js";
export { DEFAULT_MAX_STEPS } from "./agent/stop-policy.js";
export type { HarnessConfig, EmitFn, StepTrace, PrepareStepContext, PrepareStepResult } from "./agent/types.js";

// ── Skills（技能注册与挖掘）──────────────────────────────────────────────────────
export { SkillRegistry } from "./agent/skill-registry.js";
export { createSkill } from "./agent/skill-bridge.js";
export type { SkillConnector, StepsInput } from "./agent/skill-bridge.js";
export { promotableCandidates } from "./agent/skill-miner.js";

// ── Tools（工具生态：Registry + 内置 + 工厂）──────────────────────────────────────
export { ToolRegistry } from "./tools/registry.js";
export type { FlowConnector, ToolResult, ToolTier, ExecutionContext } from "./tools/base.js";
export {
  registerBuiltinTools,
  registerHeavyIoTools,
  createTavilyProvider,
  createNativeProvider,
  createWebSearchTool,
  createWebFetchTool,
  createLlmNodeTool,
  createDeliverTool,
} from "./tools/index.js";
export type { SearchProvider, SearchResult, FetchedDoc, RewriteStyle } from "./tools/index.js";
export { createDefaultToolRegistry } from "./executor/default-tools.js";

// ── Context（知识库 + 证据封装）──────────────────────────────────────────────────
export { createKnowledgeBaseTool } from "./tools/builtin/knowledge-base.js";
export { ObsidianProvider } from "./tools/knowledge/obsidian-provider.js";
export type { IKnowledgeProvider, KnowledgeSnippet, KnowledgeQuery } from "./tools/knowledge/provider.js";
export type { ObsidianProviderOptions } from "./tools/knowledge/obsidian-provider.js";
export {
  wrapEvidence,
  isEvidenceEnvelope,
  evidenceStrength,
  summarizeEvidence,
} from "./core/evidence-envelope.js";
export type { EvidenceEnvelope, Freshness, Confidence } from "./core/evidence-envelope.js";
export { wrapSnippetAsEvidence } from "./tools/knowledge/provider.js";

// ── MCP（C+T 层：Router + Action + Catalog）──────────────────────────────────────
export { McpRouter } from "./tools/mcp/mcp-router.js";
export { createMcpActionTool, registerMcpServerTools } from "./tools/mcp/mcp-action-tool.js";
export { createLazyMcpActionTool } from "./tools/mcp/lazy-mcp-action-tool.js";
export { McpKnowledgeProvider } from "./tools/mcp/mcp-knowledge-provider.js";
export { McpCatalogCache } from "./tools/mcp/mcp-catalog-cache.js";
export { KpiCatalogCache } from "./tools/mcp/kpi-catalog-cache.js";
export type { McpServerConfig, McpToolCallResult } from "./tools/mcp/mcp-client.js";
export type { CatalogVersionProvider } from "./tools/mcp/catalog-version-provider.js";
export { NoopVersionProvider } from "./tools/mcp/catalog-version-provider.js";

// ── LLM（模型服务 + 配置加载 + seed）─────────────────────────────────────────────
export { LlmService } from "./services/llm-service.js";
export type { LlmRole } from "./services/llm-service.js";
export { loadConfig } from "./llm/config-loader.js";
export type { RuntimeConfig } from "./llm/config-loader.js";
export { ensureSeedConfig } from "./llm/seed.js";
export { resolveCallSiteParams } from "./llm/llm-config.js";
export type { CallSiteParams } from "./llm/llm-config.js";

// ── Orchestrator（编排：factory + resolver 链 + 报告类型）─────────────────────────
export { createOrchestrator } from "./orchestrator/factory.js";
export { createToolResolver } from "./orchestrator/resolver-factory.js";
export { CompositeToolResolver } from "./orchestrator/composite-resolver.js";
export { CatalogSearchResolver } from "./orchestrator/catalog-search-resolver.js";
export { EmbeddingToolRouter, makeAiEmbedder } from "./orchestrator/embedding-router.js";
export { KpiResolver } from "./orchestrator/kpi-resolver.js";
export type {
  Orchestrator,
  BizContext,
  Methodology,
  SemanticNeed,
  ToolManifest,
} from "./orchestrator/types.js";
export type { ToolResolver, ResolvedTool, ResolvedComposite, KpiMissingDimension } from "./orchestrator/tool-resolver.js";
export type {
  ReportComponent,
  ComponentInstance,
  ReportMeta,
  ComponentLayout,
} from "./orchestrator/report-types.js";
export type { Embedder, CandidateTool } from "./orchestrator/embedding-router.js";

// ── Verify（前置条件 + 证据门禁）─────────────────────────────────────────────────
export { PreconditionRegistry, calledToolNames } from "./agent/precondition.js";
export type { Precondition } from "./agent/types.js";
export { evaluateEvidenceGate } from "./agent/evidence-gate.js";

// ── Governance（治理链 + 后处理规则）─────────────────────────────────────────────
export { GovernanceChain, PostToolUseChain, governanceToHooks } from "./agent/governance.js";
export type { GovernanceRule, PostToolUseRule } from "./agent/governance.js";

// ── Tasks（任务运行时 + 会话存储）────────────────────────────────────────────────
export { TaskRegistry } from "./tasks/registry.js";
export type { TaskRuntime, TaskRunnerHooks } from "./tasks/registry.js";
export { FileTaskStore } from "./tasks/task-store.js";
export type { TaskMeta } from "./tasks/task-store.js";
export { ConversationStore } from "./tasks/conversation-store.js";
export type { ConversationSummary, ConversationDetail } from "./tasks/conversation-store.js";

// ── Core（事件总线 + 配置 + 端口 + 启动日志 + 流事件 + 叙述）──────────────────────
export { EventBus, globalEventBus } from "./core/event-bus.js";
export { getDataDir, resolveAppDataDir } from "./core/config.js";
export { NEXUS_PORT } from "./core/ports.js";
export { createBootLogger } from "./core/boot-logger.js";
export type { BootLogger } from "./core/boot-logger.js";
export { narrate, narrateSummary } from "./core/narrate.js";
export type { ToolEvent } from "./core/stream-events.js";
export {
  makeEvent,
  toSSE,
  toolCallPayload,
  toolResultPayload,
} from "./core/stream-events.js";

// ── API（HTTP 形态）──────────────────────────────────────────────────────────────
export { createApp } from "./api/app.js";
