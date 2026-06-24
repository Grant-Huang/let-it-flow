import { generateText, Output } from "ai";
import type { LlmService } from "../services/llm-service.js";
import type { ToolRegistry, ToolManifest } from "../tools/registry.js";
import { WorkflowDAG } from "./dag-schema.js";
import { routeTemplate } from "./templates.js";
import type { ConsumerTemplate } from "./consumer-template.js";
import { routeConsumerTemplate, findTemplate } from "./consumer-template.js";
import { guardrailCheck } from "./guardrail.js";
import { validateDag } from "./validator.js";

/**
 * Planner —— 意图 → DAG（见 06 §6.1 两层规划）。
 *
 * 两层规划（LLM 优先，消费应用模板兜底）：
 *   0. Guardrail（规则层）：proceed / clarify / reject
 *   1. LLM 选工具（优先）：注入 forPlanner() 工具清单，LLM 据 whenToUse/outputExample
 *      自主选择工具并编排依赖，直接产出 WorkflowDAG。
 *   2. 消费应用模板兜底：LLM 不可用/失败/超时时，回退到注入的 consumerTemplates
 *      （内核不内置任何业务模板；消费应用如 podcast-generator 通过 ConsumerTemplate 注入）。
 *   3. 校验：validateDag（拓扑/工具/引用）
 *   4. 失败重试 ≤ MAX_RETRIES 次；耗尽则抛错
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
  /**
   * 是否优先用 LLM 选工具（缺省 true）。
   * 关闭后纯走消费应用模板兜底（向后兼容/测试用）。
   */
  useLlmRouter?: boolean;
  /**
   * 消费应用注入的兜底模板（如 podcast）。
   * 内核不内置任何业务模板；消费应用通过此字段注入自定义模板。
   */
  consumerTemplates?: ConsumerTemplate[];
}

export type PlanOutcome =
  | { kind: "proceed"; dag: WorkflowDAG }
  | { kind: "clarify"; questions: Array<{ field: string; prompt: string; required: boolean }> }
  | { kind: "reject"; reason: string; suggestRetry?: string };

/**
 * 规划入口：意图 → DAG / clarify / reject。
 */
export async function plan(intent: string, config: PlannerConfig): Promise<PlanOutcome> {
  const consumerTemplates = config.consumerTemplates ?? [];
  // 路由：优先消费应用模板，其次内核通用兜底（research/summary）
  const consumerMatch = routeConsumerTemplate(intent, consumerTemplates, config.registry);
  const templateId = consumerMatch ?? routeTemplate(intent);
  const guard = guardrailCheck(intent, templateId, consumerTemplates);

  if (guard.decision === "reject") {
    return { kind: "reject", reason: guard.reason ?? "不可服务", suggestRetry: guard.suggestRetry };
  }
  if (guard.decision === "clarify") {
    return { kind: "clarify", questions: guard.questions ?? [] };
  }

  // proceed：先尝试 LLM 选工具路径，失败则回退消费应用模板
  const useLlmRouter = config.useLlmRouter ?? true;
  const maxRetries = config.maxRetries ?? 3;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 优先：LLM 选工具路径（注入工具清单，LLM 自主编排 DAG）
      if (useLlmRouter) {
        const result = await planWithLlmRouter(intent, config, attempt, lastError);
        if ("dag" in result) {
          const errors = validateDag(result.dag, config.registry);
          if (errors.length === 0) {
            return { kind: "proceed", dag: result.dag };
          }
          lastError = `LLM 路由 DAG 校验失败：${errors.join("; ")}`;
          continue;
        }
        if ("error" in result) {
          // LLM 调用或解析失败：透出真实错误，作为下次重试的反馈
          lastError = result.error;
          continue;
        }
        // fallback：LLM 不可用 → 进入下面模板路径
      }

      // 兜底：消费应用模板（extractParams + build）
      const matchedTemplate = templateId
        ? findTemplate(templateId, consumerTemplates)
        : undefined;
      if (matchedTemplate) {
        const params = await matchedTemplate.extractParams(intent, config.llm);
        const wantsFull = matchedTemplate.wantsFullPipeline?.(intent) ?? false;
        const hasTools = matchedTemplate.hasRequiredTools?.(config.registry) ?? true;
        const dag = matchedTemplate.build(params, wantsFull && hasTools);
        const errors = validateDag(dag, config.registry);
        if (errors.length === 0) {
          return { kind: "proceed", dag };
        }
        lastError = errors.join("; ");
      } else {
        // 无消费模板命中 → 内核无法兜底业务 DAG
        lastError = lastError
          ? `LLM 路由未产出有效 DAG（${lastError}），且无匹配的消费应用模板`
          : "无匹配的消费应用模板，且 LLM 路由未产出有效 DAG";
        break;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // 重试耗尽抛错（不降级 Fallback DAG）
  throw new Error(`planner 重试 ${maxRetries} 次仍失败：${lastError ?? "未知错误"}`);
}

/**
 * LLM 工具选择路径：注入 forPlanner() 清单，LLM 据 whenToUse/outputExample
 * 自主选工具并编排依赖，产出 WorkflowDAG。
 *
 * 返回类型：
 *   { dag }            —— 成功
 *   { fallback: true } —— LLM 不可用（网络/鉴权/SDK/拒绝路由）→ 调用方回退模板路径
 *   { error }          —— LLM 已成功返回，但输出无法解析；调用方把 error 反馈给下次重试
 *
 * 区分 fallback 和 error 的关键：fallback 是"LLM 完全不可用"（应有兜底），
 * error 是"LLM 给了答复但不合规"（值得带错误反馈重试）。
 *
 * 按 provider 能力分两条路径（见 docs/02 §2.8 多模型平替）：
 *   - native（OpenAI 官方等）：AI SDK Output.object 原生 json_schema 约束
 *   - weak（openai-compatible/ollama，如 DeepSeek）：纯文本 prompt + 鲁棒 JSON 提取，
 *     避免发送 provider 不支持的 response_format: json_schema
 */
type LlmRouterResult =
  | { dag: WorkflowDAG }
  | { fallback: true }
  | { error: string };

async function planWithLlmRouter(
  intent: string,
  config: PlannerConfig,
  attempt: number,
  prevError?: string,
): Promise<LlmRouterResult> {
  const manifests = config.registry.forPlanner(["core", "domain"]);
  if (manifests.length === 0) return { fallback: true };

  const model = config.llm.model(config.role ?? "planner");
  const system = buildToolRouterSystemPrompt(manifests);
  const user = buildToolRouterUserMsg(intent, attempt, prevError);
  // P8.5：compatMode 改 per-callSite（按 planner 调用点解析 provider）
  const isWeakProvider = config.llm.compatModeFor("planner");
  const callArgs = llmCallArgs(system, user, isWeakProvider);

  try {
    if (isWeakProvider) {
      // weak 路径：纯文本 prompt，让 LLM 返回 JSON 文本，手动提取解析
      const weakUser = buildWeakProviderUserMsg(intent, manifests, attempt, prevError);
      const weakSystem = buildWeakProviderSystemPrompt(manifests);
      const { text } = await generateText({
        model,
        ...llmCallArgs(weakSystem, weakUser, true),
        temperature: 0.2,
      });
      const result = extractAndParseDag(text);
      if (result.dag) return { dag: result.dag };
      // 解析失败：透出真实原因供下次重试反馈，不再静默 null
      return { error: result.error };
    }

    // native 路径：AI SDK Output.object 原生约束
    const { output } = await generateText({
      model,
      ...callArgs,
      output: Output.object({ schema: WorkflowDAG }),
      temperature: 0.2,
    });
    if (!output) return { fallback: true };
    return { dag: WorkflowDAG.parse(output) };
  } catch (e) {
    // LLM 调用本身失败（网络/鉴权/SDK 不兼容/超时）→ 回退模板路径（向后兼容）
    // 这里不返回 error，因为模板路径本身就是兜底机制，LLM 不可用时不应让整个 planner 失败
    return { fallback: true };
  }
}

/**
 * weak provider 的系统提示：注入工具清单 + JSON 输出约束。
 * 与 native 路径的 buildToolRouterSystemPrompt 类似，但显式要求纯 JSON 文本输出。
 */
function buildWeakProviderSystemPrompt(manifests: ToolManifest[]): string {
  return buildToolRouterSystemPrompt(manifests) +
    "\n\n## 重要：输出格式\n" +
    "你只能输出一个合法的 JSON 对象，不要输出任何解释、markdown 代码块标记或额外文本。\n" +
    "JSON 必须符合上述 WorkflowDAG 结构（schemaVersion / nodes / onNodeError / retryAttempts）。\n" +
    '示例骨架：{"schemaVersion":"1.0","nodes":[{"id":"search_1","toolName":"core.web_search","params":{},"inputRefs":{},"dependsOn":[]}],"onNodeError":"skip","retryAttempts":0}';
}

function buildWeakProviderUserMsg(
  intent: string,
  manifests: ToolManifest[],
  attempt: number,
  prevError?: string,
): string {
  const toolNames = manifests.map((m) => m.name).join("、");
  const parts = [
    `## 用户意图\n${intent}`,
    `## 可用工具\n${toolNames}`,
    "请直接输出 WorkflowDAG 的 JSON 对象。",
  ];
  if (attempt > 0 && prevError) {
    parts.push(`## 上次错误（请修正）\n${prevError}`);
  }
  return parts.join("\n\n");
}

/**
 * 从 LLM 文本响应中鲁棒提取并解析 WorkflowDAG。
 * 处理 ```json 包裹、前导废话、尾逗号等常见 weak 模型输出问题。
 *
 * 返回结构：
 *   { dag, error: undefined } —— 成功
 *   { dag: null, error: "..." } —— 解析失败，error 描述真实原因（供下次重试反馈）
 */
type DagParseResult = { dag: WorkflowDAG; error: undefined } | { dag: null; error: string };
function extractAndParseDag(text: string): DagParseResult {
  if (!text) return { dag: null, error: "LLM 返回空文本" };
  // 1) 尝试直接提取最大的 {...} 块
  let jsonStr = text.trim();
  // 剥离 markdown 代码块包裹
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }
  // 定位首个 { 到末尾 } 的范围
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { dag: null, error: "响应中找不到 JSON 对象（缺少 { 或 }）" };
  }
  jsonStr = jsonStr.slice(start, end + 1);

  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { dag: null, error: `JSON 解析失败：${reason}` };
  }
  const parsed = WorkflowDAG.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { dag: null, error: `schema 校验失败：${issues}` };
  }
  return { dag: parsed.data, error: undefined };
}

/** 构造 LLM 工具路由的系统提示：注入全部工具契约清单。 */
function buildToolRouterSystemPrompt(manifests: ToolManifest[]): string {
  const toolList = manifests
    .map((t) => {
      const triggers = t.whenToUse.triggers.join("、");
      const notFor = t.whenToUse.notFor.join("、");
      return [
        `### ${t.name}（${t.tier}层）`,
        `功能：${t.description}`,
        `适用场景：${triggers}`,
        `不适用：${notFor}`,
        `输入参数：${JSON.stringify(t.inputSchema)}`,
        `输出：${JSON.stringify(t.outputSchema)}`,
        `输出示例：${JSON.stringify(t.outputExample)}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "你是 Let-it-Flow 的工具编排规划器。根据用户意图，从下列已注册工具中选择合适的工具，",
    "编排成一个有向无环图（DAG）的 WorkflowDAG。",
    "",
    "## 可用工具清单",
    toolList,
    "",
    "## 规划规则",
    "1. 只能使用上述工具清单中的 toolName（如 core.web_search）。",
    "2. 节点间通过 dependsOn 声明依赖顺序；通过 inputRefs 串联上游输出。",
    "3. 第一个节点通常是数据获取（web_search/web_fetch），末尾通常是 core.deliver 交付产物。",
    "4. contentPipeline 每个节点必填（含 maxTokens/strip/summarize 字段，summarize 固定 false）。",
    "5. 只输出符合 schema 的结构化对象，不要输出解释。",
    '6. schemaVersion 固定 "1.0"，onNodeError 默认 "skip"，retryAttempts 默认 0。',
    "",
    "## inputRefs 格式（关键）",
    "inputRefs 是 { JSONPath来源: 目标参数键 } 的 map，键和值都必须是字符串。",
    "- 键：指向已执行节点输出的 JSONPath，固定格式 $.tasks.{nodeId}.output 或 $.tasks.{nodeId}.output.{field}",
    "- 值：要把上游输出注入到本节点 params 的哪个键（参考工具的 inputSchema）",
    "",
    "重要：JSONPath 的起点永远是 $.tasks.{nodeId}.output，对应工具返回的原始 output 对象。",
    "不要在 output 后面再加 outputSchema 里的外层字段名（如 results/docs/text）——那些只是文档描述，不是 JSONPath 层级。",
    "",
    "正确示例：",
    '- {"$.tasks.search_1.output": "items"} —— 把 search_1 整个输出注入到 params.items',
    '- {"$.tasks.fetch_1.output[0].content": "context"} —— 取 fetch_1 输出数组首项的 content 字段，注入到 params.context',
    "",
    "## 典型链路 1：web_search → web_fetch",
    "web_search 输出是 SearchResult[]（含 title/url/snippet 字段），web_fetch 接收 fromInputRefs 参数（{url,title?}[]）。",
    "正确串联：把 web_search 整个输出数组注入到 web_fetch 的 fromInputRefs 键。",
    '示例：fetch 节点 inputRefs = {"$.tasks.search_1.output": "fromInputRefs"}',
    "不要写成 $.tasks.search_1.output.results（不存在 results 字段）。",
    "",
    "## 典型链路 2：web_fetch → llm_node",
    "web_fetch 输出是 FetchedDoc[]（含 url/title/content 字段），llm_node 接收 context 参数（字符串或数组）。",
    "正确串联：把 web_fetch 整个输出数组注入到 llm_node 的 context 键（llm_node 会自动识别 FetchedDoc[] 并拼接为可读文本）。",
    '示例：llm 节点 inputRefs = {"$.tasks.fetch_1.output": "context"}',
    "",
    "## 典型链路 3：llm_node → deliver",
    "llm_node 输出是字符串（生成的文本），deliver 接收 items 参数（字符串或字符串数组）。",
    "正确串联：把 llm_node 整个输出注入到 deliver 的 items 键。",
    '示例：deliver 节点 inputRefs = {"$.tasks.llm_1.output": "items"}',
    "",
    "错误示例（会导致 schema 校验失败，绝对不要这样写）：",
    '- {"url": "search_1.results[0].url"} —— 反了，键值顺序颠倒',
    '- {"url": {"nodeId": "search_1", "outputKey": "results[0].url"}} —— 值不能是对象',
    '- {"$.tasks.search_1.output.results": "fromInputRefs"} —— 多了 .results 层级',
  ].join("\n");
}

function buildToolRouterUserMsg(intent: string, attempt: number, prevError?: string): string {
  const parts = [`## 用户意图\n${intent}`];
  if (attempt > 0 && prevError) {
    parts.push(`## 上次错误（请修正）\n${prevError}`);
  }
  return parts.join("\n\n");
}

/**
 * 构造 generateText 的 system/messages 参数。
 * 兼容模式（DeepSeek 等）下把 system 折叠进 user 消息，规避 SDK 把 system
 * 映射成不支持的 `developer` 角色。
 */
function llmCallArgs(
  system: string,
  user: string,
  compatMode: boolean,
): { system?: string; messages: Array<{ role: "user"; content: string }> } {
  if (compatMode) {
    return { messages: [{ role: "user", content: `${system}\n\n---\n${user}` }] };
  }
  return { system, messages: [{ role: "user", content: user }] };
}
