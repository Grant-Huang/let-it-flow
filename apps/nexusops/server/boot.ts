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
import type { HarnessConfig, EmitFn } from "../../../src/agent/types.js";
import { buildNexusTools } from "../tools/index.js";
import { buildNexusSkills } from "../skills/index.js";
import { buildNexusPreconditions, nexusPreconditionList } from "./preconditions.js";
import { buildNexusGovernance } from "./governance.js";
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

  // NexusOps skill.* 沉淀流程（L 层 —— 已验证轨迹工具化）
  for (const skill of buildNexusSkills()) {
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

  // 5. V + G：业务前置条件 + 治理规则
  const preconditionReg = buildNexusPreconditions();
  const governanceChain = buildNexusGovernance();
  const preconditions = nexusPreconditionList(preconditionReg);
  const governanceHooks = governanceChain.toHooks();

  // 6. customRunner：把 ReAct Harness 接到内核 task store + HITL
  const maxSteps = Number(process.env.NEXUS_MAX_STEPS ?? "15");
  const costCapInput = process.env.NEXUS_COST_CAP_INPUT
    ? Number(process.env.NEXUS_COST_CAP_INPUT)
    : undefined;

  const customRunner: NonNullable<TaskRuntime["customRunner"]> = async (
    taskId: string,
    intent: string,
    hooks: TaskRunnerHooks,
  ) => {
    hooks.setStatus("running");
    hooks.emit("phase", { stage: "react", label: "ReAct 智能分析", state: "running" } as never);

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
    const harnessConfig: HarnessConfig = {
      callSite: "nexus_agent",
      model,
      registry: toolRegistry,
      toolTiers: ["core", "domain", "custom"],
      stopPolicy: {
        maxSteps,
        ...(costCapInput ? { costCap: { maxInputTokens: costCapInput } } : {}),
        finalizeTool: "nexus_finalize",
      },
      preconditions,
      governanceHooks,
      requireConfirmation,
      emit,
      // 兼容模式（DeepSeek 等）：折叠 system 进 user，规避 developer 角色
      compatMode: llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false,
      systemPrompt: NEXUS_SYSTEM_PROMPT,
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

    // 成功：发最终文本 + done
    if (result.finalText) {
      hooks.emit("text", { delta: result.finalText } as never);
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
`.trim();
