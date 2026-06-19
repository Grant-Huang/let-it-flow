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
} from "./agent/types.js";
export { PreconditionRegistry, calledToolNames } from "./agent/precondition.js";
export { GovernanceChain } from "./agent/governance.js";
export type { GovernanceRule } from "./agent/governance.js";
export { createSkill } from "./agent/skill-bridge.js";
export type { SkillConnector, SkillStep } from "./agent/skill-bridge.js";

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
