export { LetItFlow } from "./sdk/let-it-flow.js";
export type { LetItFlowConfig } from "./sdk/let-it-flow.js";
export type {
  StreamEvent,
  InternalEvent,
  StreamEventType,
  EventChannel,
  EmitFn,
  EventTypePayloadMap,
} from "./core/stream-events.js";
export {
  STREAM_EVENT_TYPES,
  makeEvent,
  channelOf,
  toSSE,
  serializeSSEData,
  phasePayload,
  textPayload,
  toolCallPayload,
  toolStatusPayload,
  toolResultPayload,
  workflowNodePayload,
  errorPayload,
  confirmGatePayload,
} from "./core/stream-events.js";

// ── 传输层（R1/R2 平台基础设施）─────────────────────────────────────────────────
export { EventBroadcaster, globalBroadcaster } from "./core/event-broadcaster.js";

// ── R3 协议层：extension 预设子类型 ─────────────────────────────────────────────
export {
  EXTENSION_PRESETS,
  preconditionUnmetPayload,
  artifactsPayload,
  reactResultPayload,
  stepTracePayload,
  resolveExtensionAlias,
  isPresetExtension,
} from "./core/extension-presets.js";
export type {
  PresetExtensionName,
  ConfirmGateData,
  PreconditionUnmetData,
  ArtifactItem,
  ArtifactsData,
  ReactResultData,
  StepTraceData,
} from "./core/extension-presets.js";

export type { FlowConnector, ToolResult, ToolTier, ToolTrigger, ExecutionContext } from "./tools/base.js";
export type { ToolManifest } from "./tools/registry.js";
export { ToolRegistry } from "./tools/registry.js";

// ── Harness（ETCLOVG）公共 API（见 docs/15-harness-engineering.md）────────────
export { runReactHarness } from "./agent/react-harness.js";
export type {
  HarnessConfig,
  HarnessResult,
  StepTrace,
  Precondition,
  GovernanceHooks,
  HitlGateFn,
  PrepareStepContext,
  PrepareStepResult,
} from "./agent/types.js";
export { PreconditionRegistry, calledToolNames } from "./agent/precondition.js";
export { GovernanceChain } from "./agent/governance.js";
export type { GovernanceRule } from "./agent/governance.js";
export { createSkill } from "./agent/skill-bridge.js";
export type {
  SkillConnector,
  StepCtx,
  StepsInput,
  DynamicStepsFn,
} from "./agent/skill-bridge.js";

// ── R4 步数预算（平台机制）──────────────────────────────────────────────────────
export { computeStepBudget } from "./agent/step-budget.js";
export type { StepBudget } from "./agent/step-budget.js";

// ── R5 轨迹压缩与多轮追问（平台机制）────────────────────────────────────────────
export { DefaultTraceCompressor, compressTrace } from "./agent/trace-compressor.js";
export type { TraceCompressor, TraceDigest } from "./agent/trace-compressor.js";
export { loadPreviousContext, extractStepTraceFromEvents } from "./agent/previous-context.js";

// ── R6 prepareStep 中间件模式（平台机制）────────────────────────────────────────
export { composePrepareStep, stepBudgetWarnMiddleware } from "./agent/prepare-step-middleware.js";
export type { PrepareStepMiddleware } from "./agent/prepare-step-middleware.js";

// ── R7 会话收尾结果发射器（平台机制）────────────────────────────────────────────
export { emitHarnessResult, buildSessionSummary, extractFinalizeSummary } from "./agent/result-emitter.js";
export type { SessionSummaryInput, EmitResultOptions } from "./agent/result-emitter.js";

// ── R8 catalog 版本感知刷新（平台机制）──────────────────────────────────────────
export type { CatalogVersionProvider } from "./tools/mcp/catalog-version-provider.js";
export { NoopVersionProvider } from "./tools/mcp/catalog-version-provider.js";

// ── 上下文（C 层）：KnowledgeProvider + EvidenceEnvelope ────────────────────
export type {
  IKnowledgeProvider,
  KnowledgeSnippet,
  KnowledgeQuery,
} from "./tools/knowledge/provider.js";
export { wrapSnippetAsEvidence } from "./tools/knowledge/provider.js";
export { ObsidianProvider } from "./tools/knowledge/obsidian-provider.js";
export type { ObsidianProviderOptions } from "./tools/knowledge/obsidian-provider.js";
export {
  wrapEvidence,
  isEvidenceEnvelope,
  evidenceStrength,
  summarizeEvidence,
} from "./core/evidence-envelope.js";
export type { EvidenceEnvelope } from "./core/evidence-envelope.js";

// ── MCP（C+T 层）──────────────────────────────────────────────────────────────
export { McpRouter } from "./tools/mcp/mcp-router.js";
export { McpClient } from "./tools/mcp/mcp-client.js";
export type { McpServerConfig } from "./tools/mcp/mcp-client.js";
export { createMcpActionTool, registerMcpServerTools } from "./tools/mcp/mcp-action-tool.js";
export { McpKnowledgeProvider } from "./tools/mcp/mcp-knowledge-provider.js";
export { createKnowledgeBaseTool } from "./tools/builtin/knowledge-base.js";

// ── 任务运行时（customRunner 钩子）────────────────────────────────────────────
export { TaskRegistry } from "./tasks/registry.js";
export type { TaskRuntime, TaskRunnerHooks } from "./tasks/registry.js";
export type { TaskMeta } from "./tasks/task-store.js";
