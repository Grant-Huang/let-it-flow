/**
 * 工具结果实时解读（O 层增强 —— 把工具返回转成人类可读叙述）。
 *
 * 解决"会话输出干"的核心痛点：domain 工具只 emit tool_call/tool_result，
 * 用户看到的是工具卡片亮灭，不知道拿到了什么数据、意味着什么。本模块在
 * harness 的 onStepFinish 钩子里被调用，按结果类型分流：
 *
 *   1. 确定性结果（失败 / HITL 拒绝 / governance 阻断 / 空结果）→ 结构化模板，
 *      零延迟、零 token、文本稳定。不调 LLM。
 *   2. EvidenceEnvelope（成功取回业务数据）→ 喂给轻量模型，生成 ≤80 字解读。
 *      失败降级返回空字符串（不阻断主流程，与 review-pass 一致）。
 *
 * 这种"模板兜底 + LLM 增强"的混合策略避免了"无 narrateModel 时用户什么都看不到"
 * 的退化，也避免了"对明显失败结果还浪费一次 LLM 调用"的浪费。
 *
 * 设计（与 review-pass.ts 对齐，同为"轻量模型一次性 generateText"模式）：
 *   - 纯文本 prompt + 纯文本输出（兼容弱 provider，不走 structured）
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
import { resolveCallSiteParams } from "../llm/llm-config.js";

/** narrate pass 执行选项。 */
export interface NarrateStepOptions {
  /** 轻量模型实例（由 LlmService.model("nexus_narrate") 解析）。缺省则只走模板分支。 */
  model?: LanguageModel;
  /** 兼容模式（DeepSeek 等折叠 system 进 user）。 */
  compatMode?: boolean;
  /** AbortSignal。 */
  abortSignal?: AbortSignal;
}

/**
 * 工具调用 trace 的最小形态（与 StepTrace.toolCalls[i] 结构对齐）。
 * 单独抽出避免循环导入，且让单元测试可直接构造而不依赖 SDK 类型。
 */
export interface ToolCallForNarrate {
  toolName: string;
  args: Record<string, unknown>;
  /** 工具返回结果（成功时通常是 EvidenceEnvelope）。 */
  result: unknown;
  /** 用户在 HITL 门拒绝。 */
  rejected?: boolean;
  /** 工具执行抛错时的错误信息。 */
  error?: string;
}

/** data 字段序列化时的最大长度（超长截断，防 token 爆炸）。 */
const MAX_DATA_DIGEST = 400;

/**
 * 对单步工具调用生成一段人类可读解读（混合策略入口）。
 *
 * 优先级：rejected → error → governance 阻断 → 空结果 → EvidenceEnvelope(LLM)。
 * 前 4 类走模板，最后一类走 LLM；LLM 失败/未配置返回空字符串。
 *
 * @param tc        工具调用 trace
 * @param options   模型 + 兼容模式（model 可选，缺省只走模板分支）
 * @returns         解读文本；空字符串表示无需 emit
 */
export async function narrateToolCall(
  tc: ToolCallForNarrate,
  options: NarrateStepOptions = {},
): Promise<string> {
  // 1. HITL 拒绝：用户主动拒绝，确定性结果
  if (tc.rejected) {
    return `已跳过 ${tc.toolName}（用户未确认执行）`;
  }

  // 2. 工具抛错：把 error 信息透给用户
  if (tc.error) {
    return `${tc.toolName} 执行失败：${truncateReason(tc.error)}`;
  }

  // 3. governance 阻断 / skipped：result 是带 skipped/governance_blocked 的对象
  const blockReason = detectGovernanceBlock(tc.result);
  if (blockReason) {
    return `${tc.toolName} 未执行（${blockReason}）`;
  }

  // 4. 空结果：明确告知，避免用户对着空白卡片猜测
  if (isEmptyResult(tc.result)) {
    return `${tc.toolName} 未返回数据`;
  }

  // 5. EvidenceEnvelope：走 LLM 解读（成功业务数据的核心路径）
  if (isEvidenceEnvelope(tc.result)) {
    return narrateEnvelope(tc.toolName, tc.args, tc.result, options);
  }

  // 6. 其他非信封结果（如裸对象）：交给 LLM 兜底解读，未配置模型则空
  if (options.model) {
    return narrateEnvelope(tc.toolName, tc.args, tc.result, options);
  }
  return "";
}

/**
 * @deprecated 改用 narrateToolCall（混合策略）。保留向后兼容。
 *
 * 对单步工具结果生成一段人类可读解读（仅 EvidenceEnvelope 走 LLM）。
 */
export async function narrateStepResult(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: unknown,
  options: { model: LanguageModel; compatMode?: boolean; abortSignal?: AbortSignal },
): Promise<string> {
  if (!isEvidenceEnvelope(result)) return "";
  return narrateEnvelope(toolName, toolArgs, result, options);
}

/** EvidenceEnvelope / 裸对象走 LLM 解读的内部实现。 */
async function narrateEnvelope(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: unknown,
  options: NarrateStepOptions,
): Promise<string> {
  const { model, compatMode = false, abortSignal } = options;
  if (!model) return "";

  const isEnv = isEvidenceEnvelope(result);
  const env = isEnv ? (result as EvidenceEnvelope) : undefined;
  const digest = buildDataDigest(env?.data ?? result);
  const badge = env ? summarizeEvidence(env) : "(非信封结果)";

  const system = buildNarrateSystemPrompt();
  const user = buildNarrateUserPrompt(toolName, toolArgs, digest, badge);

  try {
    const callArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
      : { system, messages: [{ role: "user" as const, content: user }] };

    const narrateParams = resolveCallSiteParams("nexus_narrate");
    const { text } = await generateText({
      model,
      ...callArgs,
      temperature: narrateParams.temperature,
      maxOutputTokens: narrateParams.maxTokens,
      abortSignal,
    });

    const cleaned = text.trim();
    if (!cleaned || cleaned.length < 4) {
      console.debug(`[narrate] 工具 ${toolName} 无有效解读（长度 < 4）`);
      return "";
    }
    console.debug(`[narrate] ${toolName} → ${cleaned.slice(0, 60)}`);
    return cleaned;
  } catch (e) {
    console.warn(`[narrate] 工具 ${toolName} 解读失败：`, e instanceof Error ? e.message : String(e));
    return "";
  }
}

/** 检测 governance 阻断 / skipped 结果，返回人类可读原因；非阻断返回空字符串。 */
function detectGovernanceBlock(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (r.governance_blocked === true && typeof r.reason === "string") {
    return `治理规则阻断：${truncateReason(r.reason)}`;
  }
  if (r.skipped === true && typeof r.reason === "string") {
    return truncateReason(r.reason);
  }
  return "";
}

/** 判定空结果（null / undefined / 空字符串 / 空对象 / 空数组）。 */
function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined || result === "") return true;
  if (typeof result === "object") {
    if (Array.isArray(result)) return result.length === 0;
    return Object.keys(result as Record<string, unknown>).length === 0;
  }
  return false;
}

/** 把过长的原因/错误信息截到一句话可读长度。 */
function truncateReason(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
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
