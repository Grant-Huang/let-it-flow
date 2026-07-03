/**
 * AI Content Factory 后端装配（应用层 —— 组装平台 harness + 应用工具/KB/规则）。
 *
 * 职责边界（ETCLOVG，镜像 apps/nexusops/server/boot.ts 模式）：
 *   - E/L/O：复用平台 runReactHarness（不重写执行循环）
 *   - T 框架：复用平台 ToolRegistry / tool-adapter；内容：注册 core.* + skill.*
 *   - C 框架：复用平台 ObsidianProvider / createKnowledgeBaseTool；内容：vault seed
 *   - V 机制：复用平台 PreconditionRegistry；内容：buildAiContentFactoryPreconditions
 *   - G 机制：复用平台 governanceToHooks；内容：buildAiContentFactoryGovernance
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
import { LlmService } from "../../../src/services/llm-service.js";
import { loadConfig } from "../../../src/llm/config-loader.js";
import { ensureSeedConfig } from "../../../src/llm/seed.js";
import { globalEventBus } from "../../../src/core/event-bus.js";
import { runReactHarness } from "../../../src/agent/react-harness.js";
import type { HarnessConfig, EmitFn, StepTrace } from "../../../src/agent/types.js";
import { governanceToHooks } from "../../../src/agent/governance.js";
import { DEFAULT_MAX_STEPS } from "../../../src/agent/stop-policy.js";
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../../../src/core/stream-events.js";
import { randomUUID } from "node:crypto";
import type { TaskRuntime, TaskRunnerHooks } from "../../../src/tasks/registry.js";
import { threadFocuserSkill, writePodcastScriptSkill, writeWechatArticleSkill, publishWechatDraftSkill } from "../skills/index.js";
import { buildAiContentFactoryPreconditions } from "./preconditions.js";
import { buildAiContentFactoryGovernance } from "./governance.js";

/** AI Content Factory 装配选项（测试可注入）。 */
export interface AiContentFactoryBootOptions {
  /** Obsidian vault 路径（缺省读 OBSIDIAN_VAULT_PATH env）。 */
  vaultPath?: string;
  /** 数据根目录（缺省读 LIF_DATA_DIR env；设了会覆盖 process.env.LIF_DATA_DIR）。 */
  dataDir?: string;
  /** 注入测试用 LlmService（缺省按 .env 构造真实 service）。 */
  llm?: LlmService;
  /** 注入测试用 toolRegistry。 */
  toolRegistry?: ToolRegistry;
  /** 注入 emit（HTTP 入口用；缺省 no-op）。 */
  emit?: EmitFn;
  /** 注入 requireConfirmation（HTTP 入口用；缺省 auto-approve）。 */
  requireConfirmation?: NonNullable<HarnessConfig["requireConfirmation"]>;
}

/** 装配产物。 */
export interface AiContentFactoryRuntime {
  /** 注入 customRunner 的 TaskRuntime（喂给 TaskRegistry）。 */
  taskRuntime: TaskRuntime;
  /** 装配好的 tool registry。 */
  toolRegistry: ToolRegistry;
  /** 装配好的 KB providers。 */
  knowledgeProviders: IKnowledgeProvider[];
}

/**
 * 装配 AI Content Factory 运行时。
 *
 * 顺序：config seed → LlmService → ToolRegistry（core builtin + skill + kb）
 *       → ObsidianProvider init → preconditions/governance → 组 customRunner → 返回 taskRuntime。
 */
export async function bootAiContentFactory(
  opts: AiContentFactoryBootOptions = {},
): Promise<AiContentFactoryRuntime> {
  // 数据目录隔离：显式 dataDir 覆盖 LIF_DATA_DIR（与 NexusOps boot 对齐）
  if (opts.dataDir) process.env.LIF_DATA_DIR = opts.dataDir;

  // 1. 配置 seed + LlmService
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

  // 2. ToolRegistry：core 内置 + podcast skill + kb
  const toolRegistry = opts.toolRegistry ?? createDefaultToolRegistry();

  // core.* 内置工具（web_search/web_fetch/llm_node/deliver）
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: process.env.TAVILY_API_KEY
      ? createTavilyProvider(process.env.TAVILY_API_KEY)
      : undefined,
  });

  // podcast skill.* 沉淀流程（动态 DSL 写法）
  for (const skill of [threadFocuserSkill, writePodcastScriptSkill, writeWechatArticleSkill, publishWechatDraftSkill]) {
    if (!toolRegistry.has(skill.name)) toolRegistry.register(skill);
  }

  // nexus_finalize sentinel（复用 nexusops 的收尾工具模式）
  if (!toolRegistry.has("nexus_finalize")) {
    toolRegistry.register(createFinalizeTool());
  }

  // 3. 知识库（C 层）：Obsidian vault
  const knowledgeProviders: IKnowledgeProvider[] = [];
  const vaultPath = opts.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH ?? "";
  if (vaultPath) {
    const obsidian = new ObsidianProvider({ vaultPath });
    await obsidian.init();
    if (obsidian.ready()) {
      knowledgeProviders.push(obsidian);
    }
  }

  // 注册 core.knowledge_base 工具
  if (!toolRegistry.has("core.knowledge_base")) {
    toolRegistry.register(createKnowledgeBaseTool(knowledgeProviders));
  }

  // 4. V + G：业务前置条件 + 治理规则
  const preconditionList = buildAiContentFactoryPreconditions();
  const governanceChain = buildAiContentFactoryGovernance();
  const governanceHooks = governanceToHooks(governanceChain);

  // 5. customRunner：把 ReAct Harness 接到内核 task store + HITL
  // PODCAST_MAX_STEPS 应用级覆盖 > LIF_MAX_STEPS 全局 > DEFAULT_MAX_STEPS
  // 注：podcast 链路比 nexus 长（多步 TTS/video），保留较高应用缺省 20
  const maxSteps = Number(process.env.PODCAST_MAX_STEPS ?? Math.max(20, DEFAULT_MAX_STEPS));

  const toolTiers: ("core" | "domain" | "custom")[] = ["core", "domain", "custom"];

  const customRunner: NonNullable<TaskRuntime["customRunner"]> = async (
    taskId: string,
    intent: string,
    hooks: TaskRunnerHooks,
  ) => {
    hooks.setStatus("running");
    hooks.emit("phase", { stage: "react", label: "播客内容生成", state: "running" } as never);

    // 用户在 HITL 确认门 reject 时置位，runReactHarness 结束后据此中止任务
    let userAborted = false;

    // emit 桥：harness 事件 → 内核 store（落库 + SSE）
    const emit: EmitFn = opts.emit ?? (async (event) => {
      hooks.emit(event.type as never, event.payload as never);
    });
    // HITL 桥：harness requireConfirmation → 内核 awaitConfirmation
    // 外层统一包裹：无论是否注入 opts.requireConfirmation，reject 都置 userAborted
    const innerConfirm = opts.requireConfirmation ?? (async (gate: Parameters<NonNullable<HarnessConfig["requireConfirmation"]>>[0]) => {
      const result = await hooks.awaitConfirmation({
        nodeId: (gate.detail?.tool as string) ?? "react_tool",
        runId: taskId,
        prompt: gate.prompt,
        options: gate.options,
        detail: gate.detail,
      });
      return { approved: result.approved, params: result.params };
    });
    const requireConfirmation = async (gate: Parameters<typeof innerConfirm>[0]) => {
      const decision = await innerConfirm(gate);
      if (!decision.approved) userAborted = true;
      return decision;
    };

    const model = llm.model("podcast_skill_agent");
    const harnessConfig: HarnessConfig = {
      callSite: "podcast_skill_agent",
      model,
      registry: toolRegistry,
      toolTiers,
      stopPolicy: {
        maxSteps,
        finalizeTool: "nexus_finalize",
      },
      preconditions: preconditionList,
      governanceHooks,
      requireConfirmation,
      emit,
      compatMode: llm.compatModeFor ? llm.compatModeFor("podcast_skill_agent") : false,
      systemPrompt: PODCAST_SYSTEM_PROMPT,
    };

    const result = await runReactHarness(intent, harnessConfig);

    hooks.emit("phase", { stage: "react", label: "播客内容生成", state: "done" } as never);

    // 无论何种 finishReason，都先发送完整 stepTrace（供下游诊断 + artifact 提取）
    hooks.emit(
      "extension",
      {
        name: "react_step_trace",
        version: "1.0",
        data: { stepTrace: result.stepTrace as StepTrace[], finalText: result.finalText },
      } as never,
    );

    // 用户在 HITL 确认门 reject：任务终止（优先于 finishReason 判定）
    if (userAborted) {
      hooks.emit(
        "extension",
        {
          name: "user_rejected",
          version: "1.0",
          data: { finishReason: "aborted", finalText: result.finalText },
        } as never,
      );
      hooks.setStatus("aborted", "用户终止了任务");
      return;
    }

    if (result.finishReason === "precondition_unmet") {
      hooks.emit(
        "extension",
        {
          name: "precondition_unmet",
          version: "1.0",
          data: { finishReason: result.finishReason, finalText: result.finalText, usage: result.usage },
        } as never,
      );
      hooks.setStatus("failed", "前置条件未满足");
      return;
    }

    if (result.finishReason === "error") {
      hooks.emit("error", { message: result.error ?? "执行出错" } as never);
      hooks.setStatus("error", result.error);
      return;
    }

    // 步数耗尽：未调用 nexus_finalize 收尾，视为失败
    if (result.finishReason === "step_count") {
      hooks.emit("error", { message: `已达到最大步数（${maxSteps}），任务未完成收尾` } as never);
      hooks.setStatus("failed", "步数耗尽未收尾");
      return;
    }

    // no_tool_call 且无 finalText：LLM 既没调工具也没输出文本，视为异常
    // （no_tool_call + 有 finalText 是合法的"反问用户"场景，走下面的成功分支发 text）
    if (result.finishReason === "no_tool_call" && !result.finalText.trim()) {
      hooks.emit("error", { message: "执行未产生任何输出" } as never);
      hooks.setStatus("failed", "执行未产生输出");
      return;
    }

    if (result.finalText) {
      hooks.emit("text", { delta: result.finalText } as never);
    }
    hooks.emit(
      "extension",
      {
        name: "react_result",
        version: "1.0",
        data: { finishReason: result.finishReason, stepCount: result.stepTrace.length, usage: result.usage },
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

  return { taskRuntime, toolRegistry, knowledgeProviders };
}

/** nexus_finalize：收尾 sentinel（harness stopWhen 检测此工具调用即终止循环）。 */
function createFinalizeTool(): FlowConnector {
  return {
    name: "nexus_finalize",
    tier: "core",
    description:
      "收尾工具。当口播稿和公众号文章都生成完毕时调用此工具结束流程。不要在内容未完成时调用。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "本次播客内容生成的总结" },
      },
      required: ["summary"],
    },
    whenToUse: {
      triggers: ["口播稿已完成", "公众号文章已完成", "可以收尾", "已经交付全部内容"],
      notFor: ["口播稿未生成", "公众号文章未生成", "还有未完成的步骤"],
    },
    outputSchema: { type: "object", properties: { finalized: { type: "boolean" } } },
    outputExample: { finalized: true },
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({ id: callId, name: "nexus_finalize", args: params, risk: "safe", groupId: "podcast" }),
      };
      const output = { finalized: true, summary: params.summary };
      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({ tool_call_id: callId, output: JSON.stringify(output), duration_ms: 0 }),
      };
      return { output, summary: "播客流程收尾" };
    },
  };
}

/** AI Content Factory 默认 system prompt（精简，铁律在 KB 里）。 */
const PODCAST_SYSTEM_PROMPT = `
你是一个播客内容策划 + 写稿助手，用 ReAct 模式工作。

## 任务流程（严格按序）

1. **判断输入模式**
   - 用户给了素材或 URL → 模式 B，用 core.web_fetch 抓全文
   - 用户只给主题/领域 → 模式 A，用 core.web_search 检索
   - 检索范围不清（"最近 X 天" 缺失）→ 直接反问用户

2. **聚焦单一主线索**
   - 检索/读取完成后，调用 skill.thread_focuser 分析所有可独立成篇的线索
   - 若线索唯一 → 直接选中
   - 若线索多条 → 让用户选择（绝不堆砌多条）

3. **判定内容类型**
   - skill.thread_focuser 同步输出 contentType：rigorous（严谨型）或 comprehensive（综合型）

4. **选择叙事结构**
   - 基于线索特征和用户输入，选择四种之一：悬念驱动、分析师独白、简报、双线对照
   - 用 core.knowledge_base 查询各结构的适用标准

5. **撰写口播稿**
   - 调用 skill.write_podcast_script
   - 内部自校验：字数（±5%）、单句长度（≤25字）、术语过滤
   - 包含引用和信源

6. **撰写公众号长文**
   - 调用 skill.write_wechat_article
   - 基于口播稿决策，扩展为 6500 字公众号文章
   - 自校验字数

7. **可选：发布到公众号草稿箱**
   - 仅当用户明确要求"发布到公众号""推送到草稿箱"时调用 skill.publish_wechat_draft
   - 需要封面图：用户提供 coverImagePath（本地路径）或 thumbMediaId（已有素材 id）
   - skill 内部会先弹出 HITL 确认门，用户批准后才真正推送（仅入草稿箱，不群发）
   - 用户未要求发布时不要主动调用

8. **收尾 + 交付**
   - 调用 nexus_finalize 汇总：口播稿 + 公众号长文 + 证据链

## 可用工具

- core.web_search：搜索内容
- core.web_fetch：拉取完整网页内容
- core.knowledge_base：查询本地知识库（叙事结构、写稿铁律）
- skill.thread_focuser：聚焦线索 + 判定类型
- skill.write_podcast_script：生成口播稿
- skill.write_wechat_article：生成公众号文章
- skill.publish_wechat_draft：把文章推送到微信公众号草稿箱（HITL 确认；仅入草稿箱不群发）
- nexus_finalize：最终收尾

## 关键约束

- 一期一个核心判断：多线索时必须让用户选，不要混合
- 先写口播再写文章：公众号文章基于口播稿的决策展开
- 必须聚焦：无论如何都要经过 skill.thread_focuser
- 知识库优先：遇到写稿规则问题，先 core.knowledge_base 再生成
`.trim();
