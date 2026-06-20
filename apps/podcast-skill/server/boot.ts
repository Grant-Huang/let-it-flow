import { LlmService } from "../../../src/services/llm-service.js";
import { PreconditionRegistry } from "../../../src/agent/precondition.js";
import { runReactHarness } from "../../../src/agent/react-harness.js";
import type { HarnessConfig, TaskIntent, TaskRunnerHooks, StepEmitter } from "../../../src/agent/types.js";
import { buildPodcastSkillPreconditions } from "./preconditions.js";
import { buildPodcastSkillGovernance } from "./governance.js";
import { threadFocuserSkill, writePodcastScriptSkill, writeWechatArticleSkill } from "../skills/index.js";

/**
 * 装配 podcast-skill ReAct 应用。
 * 镜像 apps/nexusops/server/boot.ts 的模式。
 */
export async function bootPodcastSkill(options?: {
  emit?: StepEmitter;
  requireConfirmation?: (config: any) => Promise<any>;
}): Promise<{
  customRunner: TaskRunnerHooks["customRunner"];
  preconditions: PreconditionRegistry;
}> {
  const llm = new LlmService();
  const emit = options?.emit ?? (() => {});
  const requireConfirmation = options?.requireConfirmation ?? (async (c) => c);

  // 构建工具注册表（复用 core.* + 注册 skill.*）
  const registry = {
    tools: new Map<string, any>(),
    skills: new Map<string, any>(),

    register: function (name: string, tool: any) {
      this.tools.set(name, tool);
    },

    registerSkill: function (name: string, skill: any) {
      this.skills.set(name, skill);
    },

    get: function (name: string) {
      return this.tools.get(name) ?? this.skills.get(name);
    },

    list: function () {
      return Array.from(this.tools.values()).concat(Array.from(this.skills.values()));
    },
  };

  // 注册三个核心 skill
  registry.registerSkill("skill.thread_focuser", threadFocuserSkill);
  registry.registerSkill("skill.write_podcast_script", writePodcastScriptSkill);
  registry.registerSkill("skill.write_wechat_article", writeWechatArticleSkill);

  // 构建前置条件注册表
  const preconditionRegistry = new PreconditionRegistry();
  const conditions = buildPodcastSkillPreconditions();
  for (const c of conditions) {
    preconditionRegistry.register(c);
  }

  // 构建治理规则
  const governance = buildPodcastSkillGovernance();

  // 构建 ReAct system prompt
  const systemPrompt = buildPodcastSkillSystemPrompt();

  // 构建 HarnessConfig
  const harnessConfig: HarnessConfig = {
    callSite: "podcast_skill_agent",
    model: llm.model("podcast_skill_agent"),
    registry: registry as any,
    stopPolicy: {
      maxSteps: 20,
      finalizeTool: "nexus_finalize",
    },
    preconditions: preconditionRegistry,
    governanceHooks: governance,
    requireConfirmation,
    emit,
    systemPrompt,
    compatMode: false,
  };

  // 定义 customRunner 钩子
  const customRunner: TaskRunnerHooks["customRunner"] = async (intent: TaskIntent) => {
    return runReactHarness(intent, harnessConfig);
  };

  return {
    customRunner,
    preconditions: preconditionRegistry,
  };
}

/**
 * 构建 podcast-skill 的 ReAct system prompt。
 * 极简风格：只说流程，不说细节铁律（那些在 KB 里）。
 */
function buildPodcastSkillSystemPrompt(): string {
  return `你是一个播客内容策划 + 写稿助手，用 ReAct 模式工作。

## 任务流程（严格按序）

1. **判断输入模式**
   - 用户给了素材或 URL → 模式 B，用 web_fetch 抓全文
   - 用户只给主题/领域 → 模式 A，用 web_search 检索
   - 如果检索范围不清（"最近 X 天" 缺失）→ 调 ask_user_choice 反问

2. **聚焦单一主线索**
   - 检索/读取完成后，调用 \`skill.thread_focuser\` 分析所有可独立成篇的线索
   - 若线索唯一 → 直接选中
   - 若线索多条 → 让用户选择（绝不堆砌多条）

3. **判定内容类型**
   - \`skill.thread_focuser\` 同步输出 contentType：\`rigorous\`（严谨型）或 \`comprehensive\`（综合型）

4. **选择叙事结构**
   - 基于线索特征和用户输入，选择四种之一：悬念驱动、分析师独白、简报、双线对照
   - 用 \`kb.search\` 查询各结构的适用标准

5. **撰写口播稿**
   - 调用 \`skill.write_podcast_script\`
   - 内部自校验：字数（±5%）、单句长度（≤25字）、术语过滤
   - 包含引用和信源

6. **撰写公众号长文**
   - 调用 \`skill.write_wechat_article\`
   - 基于口播稿决策，扩展为 6500 字公众号文章
   - 自校验字数

7. **收尾 + 交付**
   - 调用 \`nexus_finalize\` 汇总：口播稿 + 公众号长文 + 证据链 + rationale_meta

## 可用工具

- \`core.web_search\`：搜索内容
- \`core.web_fetch\`：拉取完整网页内容
- \`kb.search\`：查询本地知识库（叙事结构、写稿铁律）
- \`skill.thread_focuser\`：聚焦线索 + 判定类型
- \`skill.write_podcast_script\`：生成口播稿
- \`skill.write_wechat_article\`：生成公众号文章
- \`ask_user_choice\`：多选题反问
- \`nexus_finalize\`：最终收尾

## 关键约束

- **一期一个核心判断**：多线索时必须让用户选，不要混合
- **先写口播再写文章**：公众号文章基于口播稿的决策展开
- **必须聚焦**：无论如何都要经过 \`skill.thread_focuser\`
- **知识库优先**：遇到写稿规则问题，先 \`kb.search\` 再生成

祝写稿愉快！`;
}
