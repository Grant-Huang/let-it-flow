/**
 * 公开 API 稳定性注册表（见 docs/27-api-stability.md）。
 *
 * 在 0.x 阶段即对核心面作出分级承诺，避免消费者误以为「0.x = 随时可破」。
 * 本模块仅描述政策与清单，不参与运行时逻辑。
 */

/** API 稳定性等级。 */
export type StabilityLevel = "stable" | "evolving" | "experimental";

/** 单条公开面声明。 */
export interface ApiSurfaceEntry {
  /** 稳定等级 */
  stability: StabilityLevel;
  /** 自哪个版本起适用本等级 */
  since: string;
  /** 符号路径，如 `@meso.ai/let-it-flow#LetItFlow` 或 `HTTP POST /api/workflows` */
  symbol: string;
  /** 可选说明 */
  notes?: string;
}

/** 政策元信息（文档版本，非 npm 包版本）。 */
export const STABILITY_POLICY = {
  policyVersion: "1.0",
  /** 本政策自哪个 npm 版本起生效 */
  effectiveSince: "0.3.2",
  /** 包仍处 0.x；1.0.0 表示全面稳定承诺升级，而非首次引入稳定面 */
  packagePhase: "0.x" as const,
  levels: {
    stable: "破坏性变更须先 deprecate 至少一个小版本；移除推迟至 1.0.0",
    evolving: "minor 内可调整行为或签名，须写 CHANGELOG；优先 additive",
    experimental: "无兼容承诺，可在任意 patch/minor 变更或移除",
  },
} as const;

/**
 * 主入口 `@meso.ai/let-it-flow` 导出稳定性清单。
 * 键为导出名（与 src/index.ts 一致）。
 */
export const MAIN_EXPORT_STABILITY: Record<string, StabilityLevel> = {
  // ── SDK ──
  LetItFlow: "stable",
  LetItFlowConfig: "stable",

  // ── 流式协议（与 @meso.ai/types 对齐）──
  StreamEvent: "stable",
  InternalEvent: "stable",
  StreamEventType: "stable",
  EventChannel: "stable",
  EmitFn: "stable",
  EventTypePayloadMap: "stable",
  STREAM_EVENT_TYPES: "stable",
  makeEvent: "stable",
  channelOf: "stable",
  toSSE: "stable",
  serializeSSEData: "stable",
  phasePayload: "stable",
  textPayload: "stable",
  toolCallPayload: "stable",
  toolStatusPayload: "stable",
  toolResultPayload: "stable",
  workflowNodePayload: "stable",
  errorPayload: "stable",
  confirmGatePayload: "stable",

  // ── 传输层 ──
  EventBroadcaster: "stable",
  globalBroadcaster: "evolving",

  // ── Extension 预设（R3）──
  EXTENSION_PRESETS: "stable",
  preconditionUnmetPayload: "stable",
  artifactsPayload: "stable",
  reactResultPayload: "stable",
  stepTracePayload: "stable",
  resolveExtensionAlias: "stable",
  isPresetExtension: "stable",
  PresetExtensionName: "stable",
  ConfirmGateData: "stable",
  PreconditionUnmetData: "stable",
  ArtifactItem: "stable",
  ArtifactsData: "stable",
  ReactResultData: "stable",
  StepTraceData: "stable",

  // ── 工具协议 ──
  FlowConnector: "stable",
  ToolResult: "stable",
  ToolTier: "stable",
  ToolTrigger: "stable",
  ExecutionContext: "stable",
  ToolManifest: "stable",
  ToolRegistry: "stable",

  // ── Harness / Skill（ETCLOVG 核心）──
  runReactHarness: "stable",
  HarnessConfig: "stable",
  HarnessResult: "stable",
  StepTrace: "stable",
  Precondition: "stable",
  GovernanceHooks: "stable",
  HitlGateFn: "stable",
  PrepareStepContext: "stable",
  PrepareStepResult: "stable",
  PreconditionRegistry: "stable",
  calledToolNames: "stable",
  GovernanceChain: "stable",
  GovernanceRule: "stable",
  createSkill: "stable",
  SkillConnector: "stable",
  StepCtx: "stable",
  StepsInput: "stable",
  DynamicStepsFn: "stable",

  // ── R4–R7 平台机制（已发布但仍在收敛）──
  computeStepBudget: "evolving",
  StepBudget: "evolving",
  DefaultTraceCompressor: "evolving",
  compressTrace: "evolving",
  TraceCompressor: "evolving",
  TraceDigest: "evolving",
  loadPreviousContext: "evolving",
  extractStepTraceFromEvents: "evolving",
  composePrepareStep: "evolving",
  stepBudgetWarnMiddleware: "evolving",
  PrepareStepMiddleware: "evolving",
  emitHarnessResult: "evolving",
  buildSessionSummary: "evolving",
  extractFinalizeSummary: "evolving",
  SessionSummaryInput: "evolving",
  EmitResultOptions: "evolving",

  // ── R8 catalog 版本感知 ──
  CatalogVersionProvider: "evolving",
  NoopVersionProvider: "evolving",

  // ── 上下文 / 证据 ──
  IKnowledgeProvider: "stable",
  KnowledgeSnippet: "stable",
  KnowledgeQuery: "stable",
  wrapSnippetAsEvidence: "stable",
  ObsidianProvider: "evolving",
  ObsidianProviderOptions: "evolving",
  wrapEvidence: "stable",
  isEvidenceEnvelope: "stable",
  evidenceStrength: "stable",
  summarizeEvidence: "stable",
  EvidenceEnvelope: "stable",

  // ── MCP / 任务运行时 ──
  McpRouter: "evolving",
  McpClient: "evolving",
  McpServerConfig: "evolving",
  createMcpActionTool: "evolving",
  registerMcpServerTools: "evolving",
  McpKnowledgeProvider: "evolving",
  createKnowledgeBaseTool: "stable",
  TaskRegistry: "stable",
  TaskRuntime: "stable",
  TaskRunnerHooks: "stable",
  TaskMeta: "stable",
};

/**
 * 装配入口 `@meso.ai/let-it-flow/runtime` 导出稳定性清单。
 */
export const RUNTIME_EXPORT_STABILITY: Record<string, StabilityLevel> = {
  runReactHarness: "stable",
  runReviewPass: "evolving",
  DEFAULT_MAX_STEPS: "evolving",
  SkillRegistry: "stable",
  createSkill: "stable",
  promotableCandidates: "evolving",
  ToolRegistry: "stable",
  registerBuiltinTools: "stable",
  registerHeavyIoTools: "evolving",
  createDefaultToolRegistry: "evolving",
  createOrchestrator: "stable",
  createToolResolver: "evolving",
  CompositeToolResolver: "evolving",
  CatalogSearchResolver: "evolving",
  EmbeddingToolRouter: "experimental",
  makeAiEmbedder: "experimental",
  KpiResolver: "evolving",
  LlmService: "stable",
  loadConfig: "stable",
  ensureSeedConfig: "evolving",
  createApp: "stable",
  FileTaskStore: "stable",
  ConversationStore: "evolving",
  McpCatalogCache: "evolving",
  KpiCatalogCache: "evolving",
  createLazyMcpActionTool: "experimental",
  NEXUS_PORT: "experimental",
};

/** HTTP 路由稳定性（createApp 挂载）。 */
export const HTTP_ROUTE_STABILITY: ApiSurfaceEntry[] = [
  { symbol: "GET /health", stability: "stable", since: "0.1.0" },
  { symbol: "POST /api/workflows", stability: "stable", since: "0.1.0" },
  { symbol: "GET /api/tasks", stability: "stable", since: "0.1.0" },
  { symbol: "GET /api/tasks/:id", stability: "stable", since: "0.1.0" },
  { symbol: "GET /api/tasks/:id/stream", stability: "stable", since: "0.1.0", notes: "SSE 信封形状与 @meso.ai/types 一致" },
  { symbol: "POST /api/tasks/:id/confirm", stability: "stable", since: "0.1.0" },
  { symbol: "POST /api/tasks/:id/clarify", stability: "stable", since: "0.1.0" },
  { symbol: "GET /api/tools", stability: "evolving", since: "0.2.0" },
  { symbol: "GET /api/conversations", stability: "evolving", since: "0.2.0" },
  { symbol: "GET /api/conversations/:id", stability: "evolving", since: "0.2.0" },
  { symbol: "GET/POST/PUT/DELETE /api/config/models", stability: "evolving", since: "0.2.0" },
  { symbol: "GET/PUT /api/config/bindings", stability: "evolving", since: "0.2.0" },
  { symbol: "GET/PUT /api/config/system", stability: "evolving", since: "0.2.0" },
  { symbol: "GET/PUT /api/config/heavy-io", stability: "evolving", since: "0.2.0" },
];

/** 列出某入口下指定等级的符号。 */
export function listExportsByStability(
  registry: Record<string, StabilityLevel>,
  level: StabilityLevel,
): string[] {
  return Object.entries(registry)
    .filter(([, s]) => s === level)
    .map(([name]) => name)
    .sort();
}
