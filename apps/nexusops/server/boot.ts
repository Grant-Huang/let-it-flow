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
import { actionStore } from "../tools/mock-data/action-store.js";
import { buildNexusSkills } from "../skills/index.js";
import { buildNexusPreconditions, nexusPreconditionList } from "./preconditions.js";
import { buildNexusGovernance } from "./governance.js";
import { buildNexusPrepareStep } from "./prepare-step.js";
import { buildNexusPostToolUseChain } from "./post-rules.js";
import { FileTaskStore } from "../../../src/tasks/task-store.js";
import { ConversationStore } from "../../../src/tasks/conversation-store.js";
import type { TaskRuntime, TaskRunnerHooks } from "../../../src/tasks/registry.js";

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
  for (const skill of buildNexusSkills(skillRegistry)) {
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
  const mcpRouter = new McpRouter(parseMcpConfigs());
  for (const serverId of mcpRouter.listServerIds()) {
    // 写桥：把 server 工具注册成 FlowConnector
    const n = await registerMcpServerTools(toolRegistry, mcpRouter, serverId);
    if (n > 0) console.log(`[nexusops] MCP server "${serverId}" 注册 ${n} 个动作工具`);
    // 读桥：把 server resources 适配成 KB provider
    const client = mcpRouter.getClient(serverId);
    if (client) {
      const mcpKb = new McpKnowledgeProvider({ serverId, client });
      if (mcpKb.ready()) knowledgeProviders.push(mcpKb);
    }
  }

  // 注册 core.knowledge_base 工具（查询所有 KB provider）
  if (!toolRegistry.has("core.knowledge_base")) {
    toolRegistry.register(createKnowledgeBaseTool(knowledgeProviders));
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
  const prepareStep = buildNexusPrepareStep(
    allToolNames,
    llm.model("nexus_agent"),
    llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false,
  );

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
      systemPrompt: NEXUS_SYSTEM_PROMPT,
      // 工具结果解读：每步用轻量模型把 EvidenceEnvelope 转成人类可读叙述 emit 为 text
      narrateModel: llm.model("nexus_narrate"),
      narrateCompatMode: llm.compatModeFor ? llm.compatModeFor("nexus_narrate") : false,
    };

    // 发送编排说明：让用户了解我们的分析方法
    const orchestrationExplanation = generateOrchestrationExplanation(intent);
    if (orchestrationExplanation) {
      await hooks.emit("text", { delta: orchestrationExplanation } as never);
    }

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

    // 成功：发最终文本 + done
    if (result.finalText) {
      // 空行分隔执行过程与总结
      hooks.emit("text", { delta: "\n" } as never);
      hooks.emit("text", { delta: result.finalText } as never);
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

  return { taskRuntime, toolRegistry, knowledgeProviders, mcpRouter };
}

/** NexusOps 默认 system prompt（追加到 harness 默认 prompt 之后）。 */
const NEXUS_SYSTEM_PROMPT = `
## NexusOps 运营智能分析专家角色
你是精益生产/运营智能分析专家。你的工作流：
1. 先用 domain.* 工具取证一手实测数据（OEE/设备/质量/工艺/能耗/排产/物料），注意每个返回都带 EvidenceEnvelope（freshness 时效 + confidence 置信度）。
2. 必要时调 skill.oee_diagnose / skill.downtime_root_cause 走标准诊断流（已验证的沉淀流程）。
3. 用 core.knowledge_base 查企业专有知识（SOP/A3/术语表/方法论）。
4. 用 core.web_search 查外部专家通用知识。
5. 证据充分后调 nexus_advise 产出结构化建议（每条含 impact 影响度 / executionScore 执行度 / confidence 置信度；有可执行 MCP 工具才附 actionTool，否则不勉强）。
6. 最后调 nexus_finalize 收尾。

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
