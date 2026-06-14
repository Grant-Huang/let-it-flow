import { generateText, Output } from "ai";
import type { LlmService } from "../services/llm-service.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkflowDAG } from "./dag-schema.js";
import {
  PodcastParams,
  buildPodcastDag,
  extractUrls,
  type RewriteStyle,
} from "./templates.js";
import { guardrailCheck, routeTemplate } from "./guardrail.js";
import { validateDag } from "./validator.js";

/**
 * Planner —— 意图 → DAG（见 06 §6.1 两层规划）。
 *
 * MVP 流程（精简，仅 native 路径）：
 *   1. Guardrail（规则层）：proceed / clarify / reject
 *   2. 模板路由：podcast 命中 → 用 podcast 模板
 *   3. LLM 填参：generateText + Output.object 抽取 PodcastParams
 *   4. 构建 DAG：buildPodcastDag(params)
 *   5. 校验：validateDag（拓扑/工具/引用）
 *   6. 失败重试 ≤ MAX_RETRIES 次；耗尽则抛错（P4 砍 Fallback DAG）
 *
 * 砍掉的：RobustOutputGuard 弱模型路径、Fallback DAG、Critic、few-shots、评测集。
 */
export interface PlannerConfig {
  llm: LlmService;
  registry: ToolRegistry;
  /** 规划用模型的角色（缺省 planner）。 */
  role?: "planner" | "default";
  /** 校验失败重试次数。 */
  maxRetries?: number;
}

export type PlanOutcome =
  | { kind: "proceed"; dag: WorkflowDAG }
  | { kind: "clarify"; questions: Array<{ field: string; prompt: string; required: boolean }> }
  | { kind: "reject"; reason: string; suggestRetry?: string };

/**
 * 规划入口：意图 → DAG / clarify / reject。
 */
export async function plan(intent: string, config: PlannerConfig): Promise<PlanOutcome> {
  const templateId = routeTemplate(intent);
  const guard = guardrailCheck(intent, templateId);

  if (guard.decision === "reject") {
    return { kind: "reject", reason: guard.reason ?? "不可服务", suggestRetry: guard.suggestRetry };
  }
  if (guard.decision === "clarify") {
    return { kind: "clarify", questions: guard.questions ?? [] };
  }

  // proceed：抽取参数 + 构建 DAG + 校验
  const maxRetries = config.maxRetries ?? 3;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const params = await extractParams(intent, config, attempt, lastError);
      const dag = buildPodcastDag(params);
      const errors = validateDag(dag, config.registry);
      if (errors.length === 0) {
        return { kind: "proceed", dag };
      }
      lastError = errors.join("; ");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // P4：重试耗尽抛错（不降级 Fallback DAG）
  throw new Error(`planner 重试 ${maxRetries} 次仍失败：${lastError ?? "未知错误"}`);
}

/**
 * LLM 抽取 podcast 模板参数（generateText + Output.object）。
 * 失败时回退到启发式抽取（保证无 key/网络异常时也能产出可执行 DAG）。
 */
async function extractParams(
  intent: string,
  config: PlannerConfig,
  attempt: number,
  prevError?: string,
): Promise<PodcastParams> {
  const model = config.llm.model(config.role ?? "planner");
  const system = buildPlannerSystemPrompt();
  const user = buildPlannerUserMsg(intent, attempt, prevError);

  try {
    const { output } = await generateText({
      model,
      system,
      messages: [{ role: "user", content: user }],
      output: Output.object({ schema: PodcastParams }),
      temperature: 0.2,
    });
    if (output) {
      // 校验 sourceMode 与配套字段一致性，补默认值
      return normalizeParams(output, intent);
    }
    throw new Error("LLM 未返回结构化对象");
  } catch (e) {
    // 回退到启发式（无 API key / 网络异常时仍可规划）
    return heuristicParams(intent, e instanceof Error ? e.message : String(e));
  }
}

function buildPlannerSystemPrompt(): string {
  return [
    "你是 Let-it-Flow 的规划参数抽取器。从用户意图抽取播客生成所需的模板参数。",
    "只输出符合 schema 的结构化对象，不要输出解释。",
    "数据源判定：意图含 URL → sourceMode=url；否则 → sourceMode=topic 并提取主题词作为 topic。",
    "style 判定：明确要求「对话/对谈」→ dialogue；「转述/叙述」→ narration；「总结/摘要」→ summary；未指定默认 dialogue。",
  ].join("\n");
}

function buildPlannerUserMsg(intent: string, attempt: number, prevError?: string): string {
  const parts = [`## 用户意图\n${intent}`];
  if (attempt > 0 && prevError) {
    parts.push(`## 上次错误（请修正）\n${prevError}`);
  }
  return parts.join("\n\n");
}

/** 规范化 LLM 抽取结果：保证 sourceMode 与配套字段一致。 */
function normalizeParams(raw: PodcastParams, intent: string): PodcastParams {
  const urls = extractUrls(intent);
  // 若意图含 URL 但 LLM 判为 topic，纠正为 url 模式
  if (urls.length > 0 && raw.sourceMode === "topic") {
    return { ...raw, sourceMode: "url", urls };
  }
  if (raw.sourceMode === "url" && (!raw.urls || raw.urls.length === 0) && urls.length > 0) {
    return { ...raw, urls };
  }
  if (raw.sourceMode === "topic" && !raw.topic) {
    return { ...raw, topic: stripToTopic(intent) };
  }
  return raw;
}

/** 启发式抽取（LLM 不可用时的兜底）。 */
function heuristicParams(intent: string, _err: string): PodcastParams {
  const urls = extractUrls(intent);
  if (urls.length > 0) {
    return {
      sourceMode: "url",
      urls,
      style: inferStyle(intent),
      language: "zh",
      maxSearchResults: 5,
    };
  }
  return {
    sourceMode: "topic",
    topic: stripToTopic(intent),
    style: inferStyle(intent),
    language: "zh",
    maxSearchResults: 5,
  };
}

function inferStyle(intent: string): RewriteStyle {
  if (/总结|摘要|概括|summary/.test(intent)) return "summary";
  if (/转述|叙述|narration|第三人称/.test(intent)) return "narration";
  return "dialogue";
}

/** 从意图剥离关键词，提取主题。 */
function stripToTopic(intent: string): string {
  return intent
    .replace(/把|做成|做一期|制作|生成|播客|podcast|关于|的|请/g, "")
    .replace(/https?:\/\/[^\s]+/gi, "")
    .trim() || "未命名主题";
}
