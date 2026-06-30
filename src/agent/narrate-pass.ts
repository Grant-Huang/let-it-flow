/**
 * 工具结果实时解读（O 层增强 —— 把 EvidenceEnvelope 转成人类可读叙述）。
 *
 * 解决"会话输出干"的核心痛点：domain 工具只 emit tool_call/tool_result，
 * 用户看到的是工具卡片亮灭，不知道拿到了什么数据、意味着什么。本模块在
 * harness 的 onStepFinish 钩子里被调用，把每步工具返回的 EvidenceEnvelope
 * 喂给轻量模型，生成一段 ≤80 字的人类可读解读，由 harness emit 为 text 事件。
 *
 * 设计（与 review-pass.ts 对齐，同为"轻量模型一次性 generateText"模式）：
 *   - 纯文本 prompt + 纯文本输出（兼容弱 provider，不走 structured）
 *   - 失败降级返回空字符串（不阻断主流程，与 review-pass 一致）
 *   - 数据先用 summarizeEvidence() 压成徽章 + JSON.stringify(data) 截断，
 *     避免 token 爆炸
 *   - 第一人称、动词开头、点出关键数值与异常（见 docs/20 叙述规范）
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import {
  isEvidenceEnvelope,
  summarizeEvidence,
  type EvidenceEnvelope,
} from "../core/evidence-envelope.js";

/** narrate pass 执行选项。 */
export interface NarrateStepOptions {
  /** 轻量模型实例（由 LlmService.model("nexus_narrate") 解析）。 */
  model: LanguageModel;
  /** 兼容模式（DeepSeek 等折叠 system 进 user）。 */
  compatMode?: boolean;
  /** AbortSignal。 */
  abortSignal?: AbortSignal;
}

/** data 字段序列化时的最大长度（超长截断，防 token 爆炸）。 */
const MAX_DATA_DIGEST = 400;

/**
 * 对单步工具结果生成一段人类可读解读。
 *
 * @param toolName  工具名（如 "oee.realtime"）
 * @param toolArgs  工具入参（如 { line: "L01" }）
 * @param result    工具返回结果（应是 EvidenceEnvelope）
 * @param options   模型 + 兼容模式
 * @returns         解读文本（≤80 字，第一人称）；失败/非信封返回空字符串
 */
export async function narrateStepResult(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: unknown,
  options: NarrateStepOptions,
): Promise<string> {
  const { model, compatMode = false, abortSignal } = options;

  // 非 EvidenceEnvelope 不解读（core.web_search 等也可能返回信封；
  // 但动作工具的回执信封同样可解读，故只做结构校验，不限 system）
  if (!isEvidenceEnvelope(result)) return "";

  const env = result as EvidenceEnvelope;
  const digest = buildDataDigest(env.data);
  const badge = summarizeEvidence(env);

  const system = buildNarrateSystemPrompt();
  const user = buildNarrateUserPrompt(toolName, toolArgs, digest, badge);

  try {
    const callArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
      : { system, messages: [{ role: "user" as const, content: user }] };

    const { text } = await generateText({
      model,
      ...callArgs,
      temperature: 0.3,
      maxOutputTokens: 120,
      abortSignal,
    });

    const cleaned = text.trim();
    // 空输出或明显失败（只有标点）→ 返回空，让 harness 跳过 emit
    if (!cleaned || cleaned.length < 4) return "";
    return cleaned;
  } catch {
    // 解读是锦上添花，失败不阻断主流程（与 review-pass 一致）
    return "";
  }
}

/**
 * 把 data 压成精简摘要喂给 LLM。
 * 对象/数组走 JSON.stringify 并截断；原始值直接 toString。
 */
function buildDataDigest(data: unknown): string {
  if (data === null || data === undefined) return "(无数据)";
  if (typeof data !== "object") return String(data);
  const json = JSON.stringify(data);
  return json.length > MAX_DATA_DIGEST ? json.slice(0, MAX_DATA_DIGEST) + "…" : json;
}

/** narrate system prompt：定义解读员角色 + 输出约束。 */
function buildNarrateSystemPrompt(): string {
  return [
    "你是运营分析的解说员。你的任务：把刚取回的一条工具数据，用一句话讲给正在看分析过程的用户听。",
    "让用户立刻明白：拿到了什么、关键数值是多少、是否异常。",
    "",
    "## 输出规范",
    "1. 第一人称、动词开头（如：查到 / 发现 / 注意到 / 取回）",
    "2. 单条 ≤ 80 字，不写长段落",
    "3. 必须点出 1-2 个关键数值（如可用率、OEE、损失占比）",
    "4. 明显异常（如指标超阈值、置信度低）要点破",
    "5. 不输出 JSON、调试信息、参数 dump",
    "6. 进行中不收尾，自然陈述即可",
    "7. 只输出这一句话本身，不加引号、不加前缀",
  ].join("\n");
}

/** narrate user prompt：注入工具名 + 参数 + 数据摘要 + 证据徽章。 */
function buildNarrateUserPrompt(
  toolName: string,
  toolArgs: Record<string, unknown>,
  digest: string,
  badge: string,
): string {
  const argsLine = Object.keys(toolArgs).length > 0 ? JSON.stringify(toolArgs) : "(默认参数)";
  return [
    "## 刚执行的工具",
    `${toolName}（参数：${argsLine}）`,
    "",
    "## 返回数据",
    digest,
    "",
    "## 证据徽章",
    badge,
    "",
    "## 任务",
    "用一句话向用户解读这条数据的关键发现。",
  ].join("\n");
}
