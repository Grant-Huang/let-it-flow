/**
 * Podcast-Skill 后端装配（应用层 —— 镜像 nexusops/boot.ts 模板）。
 *
 * 职责（ETCLOVG）：
 *   - E/L/O：复用平台 runReactHarness
 *   - T：core.* 内置（web_search/web_fetch/kb）+ podcast_finalize / podcast_ask_choice
 *        + skill.thread_focuser / skill.write_podcast_script / skill.write_wechat_article
 *   - C：可选 ObsidianProvider（OBSIDIAN_VAULT_PATH 指向 kb-seed/vault 或自定义）
 *   - V：buildPodcastSkillPreconditions（has_focused_thread / podcast_before_article / finalize_has_both）
 *   - G：buildPodcastSkillGovernance（web_fetch 数量限）
 *
 * 装配产出：注入 customRunner 的 TaskRuntime，供 TaskRegistry.start 调用。
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
import type { HarnessConfig, EmitFn } from "../../../src/agent/types.js";
import { buildPodcastTools } from "../tools/index.js";
import { buildPodcastSkills } from "../skills/index.js";
import {
  buildPodcastSkillPreconditions,
  podcastSkillPreconditionList,
} from "./preconditions.js";
import { buildPodcastSkillGovernance } from "./governance.js";
import type { TaskRuntime, TaskRunnerHooks } from "../../../src/tasks/registry.js";

export interface PodcastSkillBootOptions {
  vaultPath?: string;
  dataDir?: string;
  llm?: LlmService;
  toolRegistry?: ToolRegistry;
}

export interface PodcastSkillRuntime {
  taskRuntime: TaskRuntime;
  toolRegistry: ToolRegistry;
  knowledgeProviders: IKnowledgeProvider[];
}

export async function bootPodcastSkill(
  opts: PodcastSkillBootOptions = {},
): Promise<PodcastSkillRuntime> {
  if (opts.dataDir) process.env.LIF_DATA_DIR = opts.dataDir;

  // 1. 配置 + LlmService
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

  // 2. ToolRegistry：core 内置 + podcast app 工具 + skill
  const toolRegistry = opts.toolRegistry ?? createDefaultToolRegistry();
  registerBuiltinTools(toolRegistry, {
    llm,
    searchProvider: process.env.TAVILY_API_KEY
      ? createTavilyProvider(process.env.TAVILY_API_KEY)
      : undefined,
  });
  for (const connector of buildPodcastTools()) {
    if (!toolRegistry.has(connector.name)) toolRegistry.register(connector);
  }
  for (const skill of buildPodcastSkills(() => llm.model("podcast_skill_agent"))) {
    if (!toolRegistry.has(skill.name)) toolRegistry.register(skill);
  }

  // 3. Obsidian KB：写稿铁律 + 叙事结构 vault
  const knowledgeProviders: IKnowledgeProvider[] = [];
  const vaultPath = opts.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH ?? "";
  if (vaultPath) {
    const obsidian = new ObsidianProvider({ vaultPath });
    await obsidian.init();
    if (obsidian.ready()) {
      knowledgeProviders.push(obsidian);
      console.log(`[podcast-skill] Obsidian vault 已加载 @ ${vaultPath}`);
    } else {
      console.warn(`[podcast-skill] Obsidian vault 未就绪：${vaultPath}`);
    }
  }
  if (!toolRegistry.has("core.knowledge_base")) {
    toolRegistry.register(createKnowledgeBaseTool(knowledgeProviders));
  }

  // 4. V + G
  const preconditionReg = buildPodcastSkillPreconditions();
  const governanceChain = buildPodcastSkillGovernance();
  const preconditions = podcastSkillPreconditionList(preconditionReg);
  const governanceHooks = governanceChain.toHooks();

  // 5. customRunner：ReAct harness 接到内核 task store + HITL
  const maxSteps = Number(process.env.PODCAST_MAX_STEPS ?? "20");

  const customRunner: NonNullable<TaskRuntime["customRunner"]> = async (
    taskId: string,
    intent: string,
    hooks: TaskRunnerHooks,
  ) => {
    hooks.setStatus("running");
    hooks.emit("phase", {
      stage: "react",
      label: "Podcast 内容策划",
      state: "running",
    } as never);

    const emit: EmitFn = async (event) => {
      hooks.emit(event.type as never, event.payload as never);
    };
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

    const model = llm.model("podcast_skill_agent");
    const harnessConfig: HarnessConfig = {
      callSite: "podcast_skill_agent",
      model,
      registry: toolRegistry,
      toolTiers: ["core", "domain", "custom"],
      stopPolicy: { maxSteps, finalizeTool: "podcast_finalize" },
      preconditions,
      governanceHooks,
      requireConfirmation,
      emit,
      compatMode: llm.compatModeFor ? llm.compatModeFor("podcast_skill_agent") : false,
      systemPrompt: PODCAST_SKILL_SYSTEM_PROMPT,
    };

    const result = await runReactHarness(intent, harnessConfig);

    hooks.emit("phase", {
      stage: "react",
      label: "Podcast 内容策划",
      state: "done",
    } as never);

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
      hooks.setStatus("failed", "前置条件未满足");
      return;
    }
    if (result.finishReason === "error") {
      hooks.emit("error", { message: result.error ?? "执行出错" } as never);
      hooks.setStatus("error", result.error);
      return;
    }

    if (result.finalText) {
      hooks.emit("text", { delta: result.finalText } as never);
    }
    hooks.emit(
      "extension",
      {
        name: "podcast_result",
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

  return { taskRuntime, toolRegistry, knowledgeProviders };
}

/** Podcast-Skill 默认 system prompt（追加到 harness 默认 prompt 后）。 */
const PODCAST_SKILL_SYSTEM_PROMPT = `
## 播客内容策划 + 写稿助手角色
你用 ReAct 模式工作。任务：基于用户意图产出 (1) 口播稿 + (2) 公众号长文 + (3) rationale。

## 任务流程（严格按序）
1. 判断输入模式：
   - 用户给了 URL/素材 → 模式 B：用 core.web_fetch 抓全文
   - 用户只给主题/领域 → 模式 A：用 core.web_search + core.web_fetch 检索
2. 时间范围不明 → 调 podcast_ask_choice 反问（最近 3 天 / 不限 / 自定义）
3. 检索/读取完成 → 调 skill.thread_focuser 聚焦单一主线索
   - 若返回 needsUserChoice=true，调 podcast_ask_choice 让用户选，再带 focusHint 重跑 thread_focuser
4. （可选）若用户未指定叙事，从 KB 检索"叙事结构/*"挑选，或默认"分析师独白体"
5. 调 skill.write_podcast_script 写口播稿（严守字数公式 + 单句长度铁律）
6. 调 skill.write_wechat_article 写公众号长文
7. 调 podcast_finalize 收尾，输出 summary + rationaleMeta

## 知识库使用
"写稿铁律" / "叙事结构" 相关问题，调 core.knowledge_base 查询 Obsidian vault。
不要把铁律塞进自己的临时记忆——按需检索。

## 纪律
- 一期一个核心线索，禁止把多条线索揉成"综合"
- 公众号长文必须基于已完成的口播稿（先稿后文）
- 收尾前必须双产物齐全（口播稿 + 公众号）+ 有 rationale
`.trim();
