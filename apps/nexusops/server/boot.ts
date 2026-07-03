/**
 * NexusOps 后端装配（应用层 —— 组装平台 harness + 应用工具/KB/规则）。
 *
 * 职责边界（ETCLOVG）：
 *   - E/L/O：复用平台 runReactHarness（不重写执行循环）
 *   - T 框架：复用平台 ToolRegistry / tool-adapter；内容：注册 NexusOps domain.* + skill.*
 *   - C 框架：复用平台 ObsidianProvider / createKnowledgeBaseTool；内容：vault seed
 *   - V 机制：复用平台 PreconditionRegistry；内容：buildNexusPreconditions
 *   - G 机制：复用平台 GovernanceChain；内容：buildNexusGovernance
 *
 * 装配产出：一个注入了 customRunner（走 ReAct Harness）的 TaskRuntime，
 * 供 TaskRegistry.start 调用。customRunner 把 harness 的 emit/SSE 事件接到
 * 内核 store，把 harness 的 requireConfirmation 接到内核 awaitConfirmation（HITL）。
 */
import "dotenv/config";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { createDefaultToolRegistry } from "../../../src/executor/default-tools.js";
import {
  registerBuiltinTools,
  createTavilyProvider,
} from "../../../src/tools/index.js";
import { createKnowledgeBaseTool } from "../../../src/tools/builtin/knowledge-base.js";
import { ObsidianProvider } from "../../../src/tools/knowledge/obsidian-provider.js";
import type { IKnowledgeProvider } from "../../../src/tools/knowledge/provider.js";
import { McpRouter } from "../../../src/tools/mcp/mcp-router.js";
import { registerMcpServerTools } from "../../../src/tools/mcp/mcp-action-tool.js";
import { McpKnowledgeProvider } from "../../../src/tools/mcp/mcp-knowledge-provider.js";
import { LlmService } from "../../../src/services/llm-service.js";
import { loadConfig } from "../../../src/llm/config-loader.js";
import { ensureSeedConfig } from "../../../src/llm/seed.js";
import { globalEventBus } from "../../../src/core/event-bus.js";
import { runReactHarness } from "../../../src/agent/react-harness.js";
import { runReviewPass, compressTrace } from "../../../src/agent/review-pass.js";
import type { HarnessConfig, EmitFn, StepTrace } from "../../../src/agent/types.js";
import { governanceToHooks } from "../../../src/agent/governance.js";
import { SkillRegistry } from "../../../src/agent/skill-registry.js";
import { promotableCandidates } from "../../../src/agent/skill-miner.js";
import { buildNexusTools } from "../tools/index.js";
import { registerMcpActionTools } from "../tools/domains/mcp-actions.js";
import { createToolResolverTool } from "../tools/tool-resolver-tool.js";
import { createQualityEvaluatorTool } from "../tools/quality-evaluator-tool.js";
import { actionStore } from "../tools/mock-data/action-store.js";
import { buildEvidenceMap } from "../tools/evidence-map.js";
import { buildNexusSkills } from "../skills/index.js";
import { buildNexusPreconditions, nexusPreconditionList } from "./preconditions.js";
import { buildNexusGovernance } from "./governance.js";
import { buildNexusPrepareStep } from "./prepare-step.js";
import { buildNexusPostToolUseChain } from "./post-rules.js";
import { FileTaskStore } from "../../../src/tasks/task-store.js";
import { ConversationStore } from "../../../src/tasks/conversation-store.js";
import type { TaskRuntime, TaskRunnerHooks } from "../../../src/tasks/registry.js";
import { createOrchestrator } from "../../../src/orchestrator/factory.js";
import { createToolResolver } from "../../../src/orchestrator/resolver-factory.js";
import type { Orchestrator, ToolManifest } from "../../../src/orchestrator/types.js";
import type { ToolResolver } from "../../../src/orchestrator/tool-resolver.js";
import { McpCatalogCache } from "../../../src/tools/mcp/mcp-catalog-cache.js";
import { EmbeddingToolRouter, makeAiEmbedder } from "../../../src/orchestrator/embedding-router.js";
import { CatalogSearchResolver } from "../../../src/orchestrator/catalog-search-resolver.js";
import { createLazyMcpActionTool } from "../../../src/tools/mcp/lazy-mcp-action-tool.js";

/** 解析 MCP server 配置（NEXUS_MCP_SERVERS env，JSON 数组）。 */
function parseMcpConfigs(): import("../../../src/tools/mcp/mcp-client.js").McpServerConfig[] {
  const raw = process.env.NEXUS_MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("[nexusops] NEXUS_MCP_SERVERS 解析失败，跳过 MCP 装配");
    return [];
  }
}

/** NexusOps 装配选项（测试可注入）。 */
export interface NexusBootOptions {
  /** Obsidian vault 路径（缺省读 OBSIDIAN_VAULT_PATH env，再缺省用内置 seed 拷贝目录）。 */
  vaultPath?: string;
  /** 数据根目录（缺省 ./data）。 */
  dataDir?: string;
  /** 注入测试用 LlmService（缺省按 .env 构造真实 service）。 */
  llm?: LlmService;
  /** 注入测试用 toolRegistry（缺省构造默认）。 */
  toolRegistry?: ToolRegistry;
}

/** 装配产物。 */
export interface NexusRuntime {
  /** 注入 customRunner 的 TaskRuntime（喂给 TaskRegistry）。 */
  taskRuntime: TaskRuntime;
  /** 装配好的 tool registry（供 /api/tools 查询）。 */
  toolRegistry: ToolRegistry;
  /** 装配好的 KB providers（调试/健康检查用）。 */
  knowledgeProviders: IKnowledgeProvider[];
  /** MCP router（优雅关闭用）。 */
  mcpRouter: McpRouter;
  /** skill 沉淀 registry（供报表固化 API / 模板匹配用）。 */
  skillRegistry: SkillRegistry;
  /** 编排知识层（MockOrchestrator，未来可热替换为 RelosOrchestrator）。 */
  orchestrator: Orchestrator;
  /** 工具语义解析层（IndexToolResolver + LlmToolResolver 组合）。 */
  toolResolver: ToolResolver;
  /** MCP catalog 预热缓存（按 serverId 索引，供 systemPrompt 注入模块地图 / EmbeddingRouter 用）。 */
  catalogCaches: Map<string, McpCatalogCache>;
  /** catalog 模式的 EmbeddingRouter（按 serverId 索引，已装配进 toolResolver 链）。 */
  catalogRouters: Map<string, EmbeddingToolRouter>;
  /** catalog 模式的在线兜底 resolver（按 serverId 索引）。 */
  catalogSearchResolvers: Map<string, CatalogSearchResolver>;
}

/**
 * 装配 NexusOps 运行时。
 *
 * 顺序：config seed → LlmService → ToolRegistry（core builtin + nexus domain + skill + kb + mcp）
 *       → ObsidianProvider init → preconditions/governance → 组 customRunner → 返回 taskRuntime。
 */
export async function bootNexusOps(opts: NexusBootOptions = {}): Promise<NexusRuntime> {
  if (opts.dataDir) process.env.LIF_DATA_DIR = opts.dataDir;

  // 1. 配置 seed（首次启动从 .env 派生）+ LlmService
  ensureSeedConfig();
  const runtimeConfig = loadConfig();
  const llm =
    opts.llm ??
    new LlmService({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      runtimeConfig,
    });
  if (!opts.llm) llm.subscribeConfigChanges(globalEventBus);

  // 2. ToolRegistry：core 内置 + NexusOps domain + skill + kb + mcp
  const toolRegistry = opts.toolRegistry ?? createDefaultToolRegistry();
  // skill 沉淀 registry（跨会话存候选/draft/active，本地 JSON 持久化；在 skill 注册前创建）
  const skillRegistry = new SkillRegistry();
  // core.* 内置工具（web_search/web_fetch/llm_node/deliver）
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: process.env.TAVILY_API_KEY
      ? createTavilyProvider(process.env.TAVILY_API_KEY)
      : undefined,
  });

  // NexusOps domain.* 业务取证工具（返回 EvidenceEnvelope）
  for (const connector of buildNexusTools()) {
    if (!toolRegistry.has(connector.name)) toolRegistry.register(connector);
  }

  // NexusOps mock MCP 动作工具（write/destructive，走 HITL 确认门）
  // 开关 NEXUS_MOCK_ACTIONS（缺省开启，测试可关闭）。命名遵循 mcp.<sys>.<tool>
  // 让 governance 规则（按 mcp.mes.*/mcp.qms.* 前缀）与 nexus_advise 的 actionTool 直接生效。
  const enableMockActions = process.env.NEXUS_MOCK_ACTIONS !== "0";
  if (enableMockActions) {
    actionStore.reset();
    for (const connector of registerMcpActionTools()) {
      if (!toolRegistry.has(connector.name)) toolRegistry.register(connector);
    }
    console.log(`[nexusops] mock MCP 动作工具已注册（${registerMcpActionTools().length} 个）`);
  }

  // NexusOps skill.* 沉淀流程（L 层 —— 手写 skill + registry active skill）
  // Phase 4.6：quality_evaluate 用便宜模型做结果质量评估
  for (const skill of buildNexusSkills({
    registry: skillRegistry,
    qualityEvalModel: llm.model("nexus_review"),
    qualityEvalCompatMode: llm.compatModeFor ? llm.compatModeFor("nexus_review") : false,
  })) {
    if (!toolRegistry.has(skill.name)) toolRegistry.register(skill);
  }

  // 3. 知识库（C 层）：Obsidian vault + MCP resources
  const knowledgeProviders: IKnowledgeProvider[] = [];
  const vaultPath = opts.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH ?? "";
  if (vaultPath) {
    const obsidian = new ObsidianProvider({ vaultPath });
    await obsidian.init();
    if (obsidian.ready()) {
      knowledgeProviders.push(obsidian);
      console.log(`[nexusops] Obsidian vault 已加载 @ ${vaultPath}`);
    } else {
      console.warn(`[nexusops] Obsidian vault 未就绪（路径不存在或为空）：${vaultPath}`);
    }
  }

  // 4. MCP server（C+T 层）：读 bridge 写工具 + 读 resources 作 KB provider
  const mcpConfigs = parseMcpConfigs();
  const mcpRouter = new McpRouter(mcpConfigs);
  /** catalog 预热缓存（catalog 模式的 server 才有，供 systemPrompt/EmbeddingRouter 用）。 */
  const catalogCaches = new Map<string, McpCatalogCache>();
  /** catalog EmbeddingRouter（向量检索路由）。 */
  const catalogRouters = new Map<string, EmbeddingToolRouter>();
  /** catalog 在线兜底 resolver。 */
  const catalogSearchResolvers = new Map<string, CatalogSearchResolver>();
  for (const cfg of mcpConfigs) {
    const serverId = cfg.id;
    const client = mcpRouter.getClient(serverId);
    if (!client) continue;

    // 写桥：catalog 模式 vs 普通模式分流
    if (cfg.catalog?.enabled) {
      // catalog 模式（07-mestar-integration-spec.md §4.3）：
      // 预热缓存而非全量注册，避免数千工具导致 context 爆炸
      const cache = new McpCatalogCache({
        serverId,
        client,
        pageSize: cfg.catalog.pageSize,
      });
      await cache.warmup(cfg.catalog.refreshMs ?? 24 * 60 * 60 * 1000);
      if (cache.isReady()) {
        catalogCaches.set(serverId, cache);
        const map = cache.getModuleMap();
        console.log(
          `[nexusops] MCP server "${serverId}" catalog 预热完成：${map?.totalTools ?? 0} 个工具（${map?.totalExecutable ?? 0} 可执行，${map?.modules.length ?? 0} 模块）`,
        );

        // 注册 LazyMcpActionTool（catalog 模式的执行入口）
        toolRegistry.register(
          createLazyMcpActionTool({ serverId, client, catalogCache: cache }),
        );

        // 构建 EmbeddingToolRouter（向量检索路由）
        const cacheDir = `data/mcp-catalog-cache/${serverId}`;
        const embedder = makeAiEmbedder(llm.embeddingModel());
        const router = new EmbeddingToolRouter({ cacheDir, embedder });
        // 优先加载已持久化的向量索引，否则构建
        if (!router.loadIndex()) {
          const buckets = cache.getAllBuckets();
          await router.buildIndex(buckets);
        }
        if (router.isReady()) {
          catalogRouters.set(serverId, router);
          console.log(
            `[nexusops] MCP server "${serverId}" EmbeddingRouter 就绪（${router.indexSize()} 个向量）`,
          );
        }

        // 构造 CatalogSearchResolver（在线兜底，回写本地索引）
        const searchResolver = new CatalogSearchResolver({
          serverId,
          client,
          onResolved: (toolName, semantic) => {
            // 回写到 tool-index.json（下次走 IndexToolResolver 命中）
            cache.appendToolEntry(toolName, semantic);
          },
        });
        catalogSearchResolvers.set(serverId, searchResolver);
      }
    } else {
      // 普通模式：全量注册（现有路径）
      const n = await registerMcpServerTools(toolRegistry, mcpRouter, serverId);
      if (n > 0) console.log(`[nexusops] MCP server "${serverId}" 注册 ${n} 个动作工具`);
    }

    // 读桥：把 server resources 适配成 KB provider（两种模式都做）
    const mcpKb = new McpKnowledgeProvider({ serverId, client });
    if (mcpKb.ready()) knowledgeProviders.push(mcpKb);
  }

  // 注册 core.knowledge_base 工具（查询所有 KB provider）
  if (!toolRegistry.has("core.knowledge_base")) {
    toolRegistry.register(createKnowledgeBaseTool(knowledgeProviders));
  }

  // 4b. 编排知识层 + 工具语义解析层（Phase 3）
  // Orchestrator（本期 MockOrchestrator，未来热替换为 RelosOrchestrator）
  const orchestrator = createOrchestrator({ dataDir: "data/relos-mock" });
  // ToolResolver（IndexToolResolver + EmbeddingToolRouter + LlmToolResolver 组合）
  // 取第一个 catalog Router 注入（多 server 时取合并候选；本期单 mestar）
  const primaryEmbeddingRouter = catalogRouters.values().next().value;
  const toolResolver = createToolResolver({
    registry: toolRegistry,
    model: llm.model("nexus_agent"),
    compatMode: llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false,
    embeddingRouter: primaryEmbeddingRouter,
  });
  // syncToolIndex：把当前 registry 工具清单（含 semanticTags）回写到 relos-mock/tool-index.json
  // 模拟企业工具索引回写 relos（未来接 relos 时走 relos API）
  const toolManifests: ToolManifest[] = toolRegistry
    .listByTiers(["core", "domain", "custom"])
    .map((t) => ({
      name: t.name,
      description: t.description,
      whenToUse: t.whenToUse,
      semanticTags: t.semanticTags,
    }));
  void orchestrator.syncToolIndex(toolManifests).catch(() => {
    // syncToolIndex 失败不阻断启动（降级为无索引，LLM 兜底解析）
  });

  // 4c. ToolResolver 工具（Phase 4.2）：把 toolResolver 暴露给 LLM
  if (!toolRegistry.has("nexus_tool_resolver")) {
    toolRegistry.register(createToolResolverTool(toolResolver));
  }

  // 4d. 质量评估工具（Phase 4.7）：LLM 自检分析结果，与 skill.quality_evaluate 共用评估内核
  // 用便宜模型（nexus_review）做评估；无此模型时降级为启发式评分
  if (!toolRegistry.has("nexus_quality_evaluate")) {
    toolRegistry.register(
      createQualityEvaluatorTool(
        llm.model("nexus_review")
          ? { model: llm.model("nexus_review"), compatMode: llm.compatModeFor ? llm.compatModeFor("nexus_review") : false }
          : {},
      ),
    );
  }

  // 5. V + G：业务前置条件 + 治理规则（pre 链全局复用，post 链每 run 新建因含会话状态）
  const preconditionReg = buildNexusPreconditions();
  const governanceChain = buildNexusGovernance();
  const preconditions = nexusPreconditionList(preconditionReg);

  // 6. customRunner：把 ReAct Harness 接到内核 task store + HITL
  const maxSteps = Number(process.env.NEXUS_MAX_STEPS ?? "15");
  const costCapInput = process.env.NEXUS_COST_CAP_INPUT
    ? Number(process.env.NEXUS_COST_CAP_INPUT)
    : undefined;

  // prepareStep 需要全部工具名列表（裁域时过滤）
  const toolTiers: ("core" | "domain" | "custom")[] = ["core", "domain", "custom"];
  const allToolNames = toolRegistry.listByTiers(toolTiers).map((t) => t.name);
  // 收尾前证据评估用主力模型（与主循环同款），仅收尾意图时触发，控制延迟
  const prepareStep = buildNexusPrepareStep({
    allToolNames,
    evidenceGateModel: llm.model("nexus_agent"),
    evidenceGateCompatMode: llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false,
    orchestrator,
  });

  // review pass 开关（默认关，生产可开；用便宜模型事后审计）
  const reviewPassEnabled = process.env.NEXUS_REVIEW_PASS === "1";

  // 会话存储（多轮追问：读上一轮产物构造压缩上下文）
  const taskStore = new FileTaskStore();
  const conversationStore = new ConversationStore(taskStore);

  const customRunner: NonNullable<TaskRuntime["customRunner"]> = async (
    taskId: string,
    intent: string,
    hooks: TaskRunnerHooks,
    context?: { parentTaskId?: string; conversationId?: string },
  ) => {
    hooks.setStatus("running");
    hooks.emit("phase", { stage: "react", label: "ReAct 智能分析", state: "running" } as never);

    // 多轮追问：从 parentTask 读取上一轮压缩上下文（仅 done 状态的 task 可作 parent）
    const previousContext = resolvePreviousContext(context, conversationStore, taskStore);

    // emit 桥：harness 事件 → 内核 store（落库 + SSE）
    const emit: EmitFn = async (event) => {
      hooks.emit(event.type as never, event.payload as never);
    };
    // HITL 桥：harness requireConfirmation → 内核 awaitConfirmation
    const requireConfirmation = async (gate: {
      prompt: string;
      options?: string[];
      detail?: Record<string, unknown>;
    }) => {
      const result = await hooks.awaitConfirmation({
        nodeId: (gate.detail?.tool as string) ?? "react_tool",
        runId: taskId,
        prompt: gate.prompt,
        options: gate.options,
        detail: gate.detail,
      });
      return { approved: result.approved, params: result.params };
    };

    const model = llm.model("nexus_agent");
    // post 链每 run 新建（含 inferred 引用计数等会话级状态）
    const governanceHooks = governanceToHooks(governanceChain, buildNexusPostToolUseChain());
    // 证据源地图：从当前已注册工具动态生成，拼到 system prompt（让 LLM 知道域→工具→证据性质）
    const evidenceMap = buildEvidenceMap(toolRegistry);
    // MCP catalog 模块目录地图（07-mestar-integration-spec.md §8）：
    // 把数千工具压缩成几十个模块目录喂给 LLM，引导其用 resolver 按需定位具体工具
    const catalogMap = buildMcpCatalogPrompt(catalogCaches);
    const systemPromptParts = [NEXUS_SYSTEM_PROMPT];
    if (evidenceMap) systemPromptParts.push(evidenceMap);
    if (catalogMap) systemPromptParts.push(catalogMap);
    const systemPrompt = systemPromptParts.join("\n\n");
    const harnessConfig: HarnessConfig = {
      callSite: "nexus_agent",
      model,
      registry: toolRegistry,
      toolTiers,
      stopPolicy: {
        maxSteps,
        ...(costCapInput ? { costCap: { maxInputTokens: costCapInput } } : {}),
        finalizeTool: "nexus_finalize",
      },
      preconditions,
      governanceHooks,
      prepareStep,
      requireConfirmation,
      emit,
      // 多轮追问：注入上一轮压缩上下文（首轮缺省）
      previousContext,
      // 兼容模式（DeepSeek 等）：折叠 system 进 user，规避 developer 角色
      compatMode: llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false,
      systemPrompt,
      // 工具结果解读：每步用轻量模型把 EvidenceEnvelope 转成人类可读叙述 emit 为 text
      narrateModel: llm.model("nexus_narrate"),
      narrateCompatMode: llm.compatModeFor ? llm.compatModeFor("nexus_narrate") : false,
    };

    const result = await runReactHarness(intent, harnessConfig);

    hooks.emit("phase", { stage: "react", label: "ReAct 智能分析", state: "done" } as never);

    // 终态：按 finishReason 决定 status
    if (result.finishReason === "precondition_unmet") {
      hooks.emit(
        "extension",
        {
          name: "precondition_unmet",
          version: "1.0",
          data: {
            finishReason: result.finishReason,
            finalText: result.finalText,
            usage: result.usage,
          },
        } as never,
      );
      hooks.setStatus("failed", "前置条件未满足，证据不足");
      return;
    }

    if (result.finishReason === "error") {
      hooks.emit("error", { message: result.error ?? "执行出错" } as never);
      hooks.setStatus("error", result.error);
      return;
    }

    // 提取 core.deliver 产出的制品，以 nexus_artifacts extension 通知前端
    const artifactItems: Array<{ type: string; title: string; description?: string }> = [];
    for (const step of result.stepTrace) {
      for (const tc of step.toolCalls) {
        if (tc.toolName === "core.deliver" && tc.result) {
          try {
            const parsed = typeof tc.result === "string" ? JSON.parse(tc.result) : tc.result;
            if (parsed && typeof parsed === "object" && "type" in parsed) {
              artifactItems.push({
                type: String(parsed.type ?? "text"),
                title: String(parsed.title ?? tc.toolName),
                description: parsed.content ? String(parsed.content).slice(0, 80) : undefined,
              });
            }
          } catch {
            // 忽略解析失败
          }
        }
      }
    }
    if (artifactItems.length > 0) {
      hooks.emit(
        "extension",
        { name: "nexus_artifacts", version: "1.0", data: { items: artifactItems } } as never,
      );
    }

    hooks.emit(
      "extension",
      {
        name: "react_result",
        version: "1.0",
        data: {
          finishReason: result.finishReason,
          stepCount: result.stepTrace.length,
          usage: result.usage,
        },
      } as never,
    );

    // 持久化完整 stepTrace（供多轮追问还原上一轮压缩上下文）
    hooks.emit(
      "extension",
      {
        name: "react_step_trace",
        version: "1.0",
        data: { stepTrace: result.stepTrace, finalText: result.finalText },
      } as never,
    );

    // C 层 review pass：finalize 后用便宜模型审计"证据-结论"链路（可选，默认关）
    if (reviewPassEnabled) {
      try {
        const reviewModel = llm.model("nexus_review");
        const review = await runReviewPass(result.stepTrace, result.finalText, {
          model: reviewModel,
          compatMode: llm.compatModeFor ? llm.compatModeFor("nexus_review") : false,
        });
        hooks.emit(
          "extension",
          {
            name: "review_report",
            version: "1.0",
            data: review,
          } as never,
        );
      } catch {
        // review 失败不阻断主结果（锦上添花）
      }
    }

    // L 层 skill 挖矿：把本次轨迹喂给 miner，有新候选则登记 + emit 提示
    try {
      const newCands = promotableCandidates([result.stepTrace]);
      if (newCands.length > 0) {
        const updated = skillRegistry.registerCandidates(newCands);
        const promotable = skillRegistry.promotableCandidates();
        if (promotable.length > 0) {
          hooks.emit(
            "extension",
            {
              name: "skill_candidates",
              version: "1.0",
              data: {
                candidates: promotable.slice(0, 3).map((c) => ({
                  signature: c.signature,
                  occurrences: c.occurrences,
                  sampleSequence: c.sampleSequence,
                })),
                hint: "检测到可复用模式，是否沉淀为 skill？",
              },
            } as never,
          );
        }
        void updated;
      }
    } catch {
      // 挖矿失败不阻断主结果
    }

    hooks.emit("done", {} as never);
    hooks.setStatus("done");
  };

  const taskRuntime: TaskRuntime = {
    llm,
    toolRegistry,
    customRunner,
  };

  return { taskRuntime, toolRegistry, knowledgeProviders, mcpRouter, skillRegistry, orchestrator, toolResolver, catalogCaches, catalogRouters, catalogSearchResolvers };
}

/**
 * 把 MCP catalog 预热缓存渲染成模块目录地图（注入 systemPrompt）。
 *
 * 07-mestar-integration-spec.md §8：LLM 看到的不是 2850 个工具描述，
 * 而是约 30 个模块的目录（<2K token）。LLM 的行为模式变为
 * "我知道有设备BOM 这个域 → 用 resolver 找具体工具"。
 */
function buildMcpCatalogPrompt(caches: Map<string, McpCatalogCache>): string {
  if (caches.size === 0) return "";
  const sections: string[] = [];
  for (const [serverId, cache] of caches) {
    const map = cache.getModuleMap();
    if (!map || map.modules.length === 0) continue;
    const moduleList = map.modules
      .map((m) => `- ${m.name}：${m.desc}（${m.executableCount} 个可查询工具）`)
      .join("\n");
    sections.push(
      `### ${serverId} catalog（已缓存 ${map.totalTools} 个工具，按模块组织，只展示可查询工具数）\n${moduleList}\n\n不确定具体工具时：\n1. 调 nexus_tool_resolver(semantic="<业务语义>") 按语义查找\n2. 调 mcp.${serverId}.call(toolName="<resolver 返回>", args={...}) 执行`,
    );
  }
  return sections.length > 0 ? `## 可用的 MCP 业务系统\n${sections.join("\n\n")}` : "";
}

/** NexusOps 默认 system prompt（追加到 harness 默认 prompt 之后）。 */
const NEXUS_SYSTEM_PROMPT = `
## NexusOps 运营智能分析专家角色
你是精益生产/运营智能分析专家。你的工作流：
1. 先用 domain.* 工具取证一手实测数据（OEE/设备/质量/工艺/能耗/排产/物料），注意每个返回都带 EvidenceEnvelope（freshness 时效 + confidence 置信度）。
2. 必要时调 skill.oee_diagnose / skill.downtime_root_cause / skill.multi_perspective_rca 走标准诊断流（已验证的沉淀流程）。跨域组合分析用 skill.waste_audit（七大浪费）/ skill.dmaic（改善项目）/ skill.cost_summary（成本汇总）。
3. 用 core.knowledge_base 查企业专有知识（SOP/A3/术语表/方法论）。
4. 用 core.web_search 查外部专家通用知识。
5. 证据充分后调 nexus_advise 产出结构化建议（每条含 impact 影响度 / executionScore 执行度 / confidence 置信度；有可执行 MCP 工具才附 actionTool，否则不勉强）。
5b. 建议产出后，调 skill.report_html 生成可视化 HTML 报告，供右栏展示。报告主题必须与前置分析一致，按 reportType 选匹配模板，禁止用错配模板覆盖主题：
  - 前置为 DMAIC/6Sigma 分析（调过 skill.dmaic 或 quality.sigma_level/dpmo）→ reportType="dmaic"：渲染 σ/DPMO/Cpk 目标 + D-M-A-I-C 五阶段路线图，不要传 primaryRootCause（模板内部自动取数，聚焦改善路径而非根因树）。
  - 前置为 OEE 诊断 / 停机根因 / 多视角根因（调过 skill.oee_diagnose / skill.downtime_root_cause / skill.multi_perspective_rca）→ reportType="oee"（缺省）：传入 primaryRootCause/mechanismExplained/auxiliaryFactors/confidence 及 recommendations 列表。
  - 前置为七大浪费 / 成本汇总 / 通用兜底分析 → 暂用 reportType="oee"（缺省）。
  - 主题一致性纪律：若前置分析是 DMAIC，绝不用 oee 模板（否则 σ/DPMO 主题会被 OEE 根因树覆盖）。
6. 收尾前调 nexus_quality_evaluate 对本次分析结果做多维质量评分（主题一致性/证据充分性/根因合理性/建议可执行性/方法合规性），产出评估报告（参考性评分，用于自检与改进）。
7. 最后调 nexus_finalize 收尾。

## 编排知识层与工具解析（LLM 主导）
- **方法论指导**：每轮分析首步会收到来自编排知识层（Orchestrator）的方法论指导（注入到 system prompt）。指导含阶段路线图（如 DMAIC 的 D→M→A→I→C）和每阶段必取证项。严格按阶段顺序执行，不要跳过必取证项。
- **知识来源标记**：指导末尾标注 \`source\` 字段。当前为 \`source=mock\`（模拟知识，可参考但允许自主判断）。未来 \`source=relos\` 时知识更可信。
- **工具语义解析**：不确定该用哪个工具时，调 \`nexus_tool_resolver\` 按语义查找（输入 semantic 如 "process_capability"，返回匹配工具名 + 来源）。优先用此工具而非硬记工具名。
- **方法论与报告主题一致**：不同方法论产出不同形态的报告。DMAIC → σ/DPMO 改善路线图；OEE 诊断 → 根因树；QS16949 内审 → 符合性评估（四大工具齐备度 + NC 清单，**不需要根因诊断**）；七大浪费 → 浪费量化；能耗分析 → 能耗趋势。不要把所有问题都套成根因诊断。

## 开放问题类型（不止根因诊断）
分析问题分两类，方法论指导会帮你区分：
- **诊断类**（找根因）：如 OEE 偏低、停机频发、缺陷率高。走 5Why + 鱼骨图 + 根因树。
- **符合性评估类**（查合规）：如 IATF 16949 内审、过程审核。走"对照标准 → 收集证据 → 找差距 → 输出不符合项（NC）"。这类问题**不需要根因诊断**，prepare-step 不会强制要求因果链。

## 证据纪律
- freshness=estimated/historical 或 confidence=inferred 的证据，需交叉验证后再下结论。
- 给建议前确认是否满足前置条件（如 OEE 结论需 oee.* 实测、停机结论需 equipment.* 取证）。
- 不确定时优先补取证，而非凭模型先验硬答。

## 建议 quality
- impact/executionScore/confidence 都在 0-1 之间，给真实估计而非全部 0.9。
- 行动按钮：仅当确有对应 MCP 动作工具且参数明确时附 actionTool+actionArgs；否则留空（宁可不给按钮也不勉强）。
- 证据齐备、准备给出建议时，先用一句固定过渡语收束取证阶段（如"证据已齐，我来给出建议。"），让用户感知阶段切换。
- 可用的 MCP 动作工具（mcp.<系统>.<动作>，附 actionTool 时用全名）：
  - mcp.mes.schedule_work_order（重排工单）、mcp.mes.changeover（换模调度）、mcp.mes.reallocate_capacity（产能重分配）
  - mcp.erp.purchase_request（采购申请）、mcp.erp.material_issue（领料出库）
  - mcp.qms.quarantine（质量隔离）、mcp.qms.rework_order（返工单）、mcp.qms.scrap_batch（批量报废，destructive 慎用）
  - mcp.eam.maintenance_order（维护工单）、mcp.eam.spare_part_order（备件订购）、mcp.eam.stop_line（停线，destructive 慎用）
  - mcp.process.adjust_parameters（工艺参数回调，参数漂移首选）
- destructive 动作（停线/批量报废）仅在确有安全/不可挽回风险时建议，且必须附具体 reason；正常工况绝不建议 destructive 动作。

## 因果链纪律（必须遵守）
- 得出根因结论前，必须先调 quality.five_why 或 quality.fishbone 取证，或调用 skill.oee_diagnose / skill.downtime_root_cause。禁止仅凭 healthScore 低或 deviationScore 高直接跳根因结论。
- 当设备/工艺/人员多维度异常同时存在时：以 quality.five_why 的 chains[0].rootCause 为主根因；其他维度降级标注为"辅助因素"或"关联症状"，不得并列为多个并列根因。
- 每条建议的 evidenceRefs 必须列出提供该数据的具体工具名（如 quality.five_why、process.quality_impact、equipment.health）。
- 若 quality.five_why 返回空 chains（normal 场景），说明无已识别根因，需诚实说明"当前证据不足以确定根因，建议现场 5Why 补充排查"，不得凭 LLM 先验编造根因。
- 工艺参数偏差导致质量缺陷时，必须调 process.quality_impact 获取「偏差量→物理机制→缺陷类型」完整映射；不得仅凭"温度偏高"直接写"导致尺寸超差"而不说明物理机制。
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// 意图理解和编排说明生成辅助函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 根据用户意图生成"意图理解"的文本说明，帮助用户确认我们的理解。
 * 如果 intent 过长或复杂，可能返回 undefined（略去不显示）。
 */
function generateIntentSummary(intent: string): string | undefined {
  // 简单启发式：如果 intent 包含问号或疑问词，就认为是合法问题
  // 实际可接入 LLM 来生成更自然的表述
  if (intent.length > 200) {
    // 太长的意图，略去不显示
    return undefined;
  }

  // 检查是否包含问题关键词
  const questionPatterns = [
    /为什么|什么|怎样|如何|帮我|分析|诊断|查看|检查/,
    /OEE|停机|缺陷|良率|产能|成本|能耗/,
  ];

  const isQuestion = questionPatterns.some((p) => p.test(intent));
  if (!isQuestion) {
    return undefined;
  }

  // 生成简短的理解确认语（可扩展为调用 LLM）
  return `\n我理解你的需求是：${intent}\n`;
}

/**
 * 根据用户意图生成"编排说明"的文本说明，描述我们的分析方法。
 * 这帮助用户了解后续会执行的步骤。
 */
function generateOrchestrationExplanation(intent: string): string | undefined {
  // 简单启发式：根据 intent 的关键词选择不同的分析方法
  // 实际可接入 LLM 来生成更自然的表述

  let methodology = "";

  if (intent.includes("OEE") || intent.includes("效率")) {
    methodology = "我将从 OEE 三维度（可用率、性能、质量）分解问题，查实测数据，并用多视角分析（鱼骨图、FMEA）交叉验证，最后给出改善建议。";
  } else if (intent.includes("停机") || intent.includes("下降")) {
    methodology = "我将先查设备停机日志和根本原因，再用 5Why 和故障树分析，查找深层触发因素，最后给出预防和改善方案。";
  } else if (intent.includes("缺陷") || intent.includes("良率")) {
    methodology = "我将分析缺陷分布（帕累托分析），找出主要不良模式，再用工艺参数和过程能力分析定位原因，最后给出质量改善方案。";
  } else if (intent.includes("成本") || intent.includes("效益")) {
    methodology = "我将从成本结构和关键驱动因素入手，分析物料成本、能耗、产能利用等，给出成本优化方向。";
  } else {
    methodology = "我将通过数据取证、多视角分析、证据交叉验证，为你给出数据驱动的建议。";
  }

  return `\n我的分析方法是：${methodology}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 多轮追问辅助：从 parentTask 还原上一轮压缩上下文
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多轮追问上下文解析。
 *
 * 策略（按优先级）：
 *   1. context.parentTaskId 显式指定 → 读该 task
 *   2. context.conversationId 存在 → 取会话内最近一个 done task
 *   3. 无 parent（首轮）→ 返回 undefined
 *
 * 仅 done 状态的 task 可作 parent（避免把失败上下文喂给 LLM）。
 */
function resolvePreviousContext(
  context: { parentTaskId?: string; conversationId?: string } | undefined,
  conversationStore: ConversationStore,
  taskStore: FileTaskStore,
): HarnessConfig["previousContext"] {
  if (!context) return undefined;

  // 1. 显式 parentTaskId
  let parentMeta = context.parentTaskId ? taskStore.get(context.parentTaskId) : null;

  // 2. 回退：取会话最近 done task
  if (!parentMeta && context.conversationId) {
    parentMeta = conversationStore.getLatestCompleted(context.conversationId);
  }

  if (!parentMeta || parentMeta.status !== "done") return undefined;

  const extracted = extractStepTraceFromTask(parentMeta.id, taskStore);
  if (!extracted) return undefined;

  return {
    intent: parentMeta.intent,
    traceDigest: compressTrace(extracted.stepTrace),
    finalText: extracted.finalText,
  };
}

/**
 * 从 task 的 events.jsonl 还原 stepTrace + finalText。
 *
 * 读取 customRunner 在成功路径落库的 extension(react_step_trace) 事件。
 * 兼容旧 task（无此事件）时返回 null（首轮/降级为无上下文）。
 */
function extractStepTraceFromTask(
  taskId: string,
  taskStore: FileTaskStore,
): { stepTrace: StepTrace[]; finalText: string } | null {
  const events = taskStore.readByType(taskId, "extension");
  for (const ev of events) {
    const payload = ev.payload as { name?: string; data?: Record<string, unknown> };
    if (payload?.name !== "react_step_trace") continue;
    const data = payload.data ?? {};
    const stepTrace = data.stepTrace;
    const finalText = typeof data.finalText === "string" ? data.finalText : "";
    if (Array.isArray(stepTrace)) {
      return { stepTrace: stepTrace as StepTrace[], finalText };
    }
  }
  return null;
}
