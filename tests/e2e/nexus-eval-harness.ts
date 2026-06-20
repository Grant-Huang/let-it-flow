/**
 * NexusOps e2e 评测公共基建（@e2e，默认排除，手动触发）。
 *
 * 提供驱动单条真实 ReAct 分析 + 判官评分的复用函数：
 *  - runAnalysis：真实 bootNexusOps 装配 → TaskRegistry → start → join → 读事件流
 *  - extractCalledTools / extractRecommendations：从事件流解析取证链 + 建议产物
 *  - judgeRecommendations：调 DeepSeek-flash 判官，5 维 rubric 评分（0-2，总 10）
 *
 * 全程真实 LLM 网络调用（读 .env DeepSeek key），不做 mock。
 */
import { generateText } from "ai";
import { z } from "zod";
import { bootNexusOps } from "../../apps/nexusops/server/boot.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import { LlmService } from "../../src/services/llm-service.js";
import { loadConfig } from "../../src/llm/config-loader.js";
import { ensureSeedConfig } from "../../src/llm/seed.js";
import { globalEventBus } from "../../src/core/event-bus.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** e2e 运行结果。 */
export interface AnalysisResult {
  taskId: string;
  status: string;
  events: StreamEvent[];
  /** 按序调用的工具名（含重复）。 */
  calledTools: string[];
  /** nexus_advise 产出的建议列表。 */
  recommendations: Recommendation[];
  /** 取证阶段调用过的工具名集合（排除 nexus_finalize/nexus_advise）。 */
  evidenceTools: string[];
  /** 累积的 finalText（text 事件 delta 拼接）。 */
  finalText: string;
  /** 任务错误信息（status=error 时）。 */
  error?: string;
}

/** nexus_advise 输出的单条建议（schema 见 apps/nexusops/tools/index.ts:86-109）。 */
export interface Recommendation {
  title: string;
  rationale: string;
  impact: number;
  executionScore: number;
  confidence: number;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
  evidenceRefs?: string[];
}

/** 判官评分结果。 */
export interface JudgeResult {
  scores: {
    evidenceBased: number;      // 0-2
    actionability: number;      // 0-2
    prioritization: number;     // 0-2
    specificity: number;        // 0-2
    confidenceCalibration: number; // 0-2
  };
  total: number;     // 0-10
  reasoning: string;
  pass: boolean;     // total >= PASS_THRESHOLD
}

/** 判官通过阈值（total >= 7 视为 pass）。 */
export const JUDGE_PASS_THRESHOLD = 7;

/** 单例 LlmService（真实，读 .env）。 */
let _llm: LlmService | null = null;
function getLlm(): LlmService {
  if (_llm) return _llm;
  ensureSeedConfig();
  _llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });
  _llm.subscribeConfigChanges(globalEventBus);
  return _llm;
}

/**
 * 驱动单条真实 ReAct 分析。
 * @param intent 用户意图
 * @param opts.dataDir 数据根目录（缺省 ./data，测试隔离用临时目录）
 */
export async function runAnalysis(
  intent: string,
  opts: { dataDir?: string } = {},
): Promise<AnalysisResult> {
  if (opts.dataDir) process.env.LIF_DATA_DIR = opts.dataDir;

  const runtime = await bootNexusOps({ llm: getLlm() });
  const registry = new TaskRegistry(undefined, runtime.taskRuntime);

  const meta = registry.start(intent);
  const taskId = meta.id;
  await registry.join(taskId);

  const finalMeta = registry.getStore().get(taskId);
  const events = registry.getStore().readSince(taskId, 0);

  const calledTools = extractCalledTools(events);
  const recommendations = extractRecommendations(events);
  const evidenceTools = calledTools.filter(
    (n) => !n.startsWith("nexus_") && n !== "core.web_search" && n !== "core.web_fetch",
  );
  const finalText = collectText(events);

  return {
    taskId,
    status: finalMeta?.status ?? "unknown",
    events,
    calledTools,
    recommendations,
    evidenceTools,
    finalText,
    error: finalMeta?.error,
  };
}

/** 从事件流按序提取 tool_call 的工具名。 */
export function extractCalledTools(events: StreamEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== "tool_call") continue;
    const name = (ev.payload as { name?: string }).name;
    if (name) out.push(name);
  }
  return out;
}

/** 从事件流提取 nexus_advise 的 tool_result，解析出 recommendations[]。 */
export function extractRecommendations(events: StreamEvent[]): Recommendation[] {
  // 先建 tool_call_id → toolName 映射
  const callIdToName = new Map<string, string>();
  for (const ev of events) {
    if (ev.type !== "tool_call") continue;
    const p = ev.payload as { id?: string; name?: string };
    if (p.id && p.name) callIdToName.set(p.id, p.name);
  }
  // 找 nexus_advise 的 tool_result
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    const p = ev.payload as { tool_call_id?: string; output?: string };
    const name = p.tool_call_id ? callIdToName.get(p.tool_call_id) : undefined;
    if (name !== "nexus_advise") continue;
    if (!p.output) continue;
    try {
      const env = JSON.parse(p.output) as { data?: { recommendations?: Recommendation[] } };
      const recs = env.data?.recommendations;
      if (Array.isArray(recs)) return recs;
    } catch {
      // 解析失败忽略
    }
  }
  return [];
}

/** 拼接 text 事件 delta（finalText 粗略近似）。 */
function collectText(events: StreamEvent[]): string {
  let out = "";
  for (const ev of events) {
    if (ev.type !== "text") continue;
    const delta = (ev.payload as { delta?: string }).delta;
    if (delta) out += delta;
  }
  return out;
}

/** 判官 rubric 输出 schema（用于校验从 LLM 文本中提取的 JSON）。 */
const JudgeSchema = z.object({
  scores: z.object({
    evidenceBased: z.number(),
    actionability: z.number(),
    prioritization: z.number(),
    specificity: z.number(),
    confidenceCalibration: z.number(),
  }),
  reasoning: z.string(),
});

/** 把任意数值 clamp 到 [0,2] 区间（容错 LLM 偶发输出 3 或 -1）。 */
function clamp2(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(2, Math.round(v)));
}

/** 从 LLM 文本响应中提取并解析判官 JSON（参考 planner.extractAndParseDag 模式）。 */
function parseJudgeText(text: string): z.infer<typeof JudgeSchema> | null {
  if (!text) return null;
  let jsonStr = text.trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) jsonStr = fence[1].trim();
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(jsonStr.slice(start, end + 1));
    return JudgeSchema.safeParse(obj).success ? (obj as z.infer<typeof JudgeSchema>) : null;
  } catch {
    return null;
  }
}

/**
 * 判官：用 DeepSeek-flash 对建议质量打分。
 *
 * 5 维 rubric（各 0-2，总 10）：
 *  - evidenceBased：rationale 是否真实引用取证证据（非空泛套话）
 *  - actionability：actionTool 是否合理（有真实可执行 MCP 才给按钮，否则留空正确）
 *  - prioritization：impact×executionScore 排序是否符合"先治根因再优化"
 *  - specificity：是否具体到设备/参数/数值（非"加强管理"套话）
 *  - confidenceCalibration：confidence 是否与证据强度匹配
 *
 * 主循环用 pro（强推理），判官用 flash（便宜快、结构化评分足够）。
 *
 * 注意：DeepSeek 不支持 response_format json_schema，故不走 Output.object，
 * 改用纯文本 generateText + 手动 JSON 提取（参考 planner.extractAndParseDag）。
 *
 * @param intent 原始意图
 * @param recommendations 建议列表
 * @param evidenceTools 取证阶段调过的工具名集合
 * @param expectedEvidenceStrength 期望证据强度（0-1，由场景决定：anomaly≈0.6, crisis≈0.4）
 */
export async function judgeRecommendations(
  intent: string,
  recommendations: Recommendation[],
  evidenceTools: string[],
  expectedEvidenceStrength: number,
): Promise<JudgeResult> {
  const llm = getLlm();
  const model = llm.model("nexus_advise");
  const compatMode = llm.compatModeFor ? llm.compatModeFor("nexus_advise") : false;

  const recsJson = JSON.stringify(
    recommendations.map((r) => ({
      title: r.title,
      rationale: r.rationale,
      impact: r.impact,
      executionScore: r.executionScore,
      confidence: r.confidence,
      actionTool: r.actionTool ?? "",
      evidenceRefs: r.evidenceRefs ?? [],
    })),
    null,
    2,
  );

  const system = JUDGE_SYSTEM_PROMPT;
  const user = `## 原始意图
${intent}

## ReAct 取证阶段调过的工具（证据来源）
${evidenceTools.join(", ") || "（无）"}

## 期望证据强度（0-1，场景越异常证据越弱/越分散）
${expectedEvidenceStrength.toFixed(2)}

## 待评建议
${recsJson}

## 任务
按 5 维 rubric 打分（各 0-2 整数），返回 JSON。reasoning 用中文说明扣分理由。`;

  const callArgs = compatMode
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
    : { system, messages: [{ role: "user" as const, content: user }] };

  const { text } = await generateText({ model, ...callArgs, temperature: 0 });
  const parsed = parseJudgeText(text);
  const rawScores = parsed?.scores;

  const scores = {
    evidenceBased: clamp2(rawScores?.evidenceBased),
    actionability: clamp2(rawScores?.actionability),
    prioritization: clamp2(rawScores?.prioritization),
    specificity: clamp2(rawScores?.specificity),
    confidenceCalibration: clamp2(rawScores?.confidenceCalibration),
  };
  const total =
    scores.evidenceBased +
    scores.actionability +
    scores.prioritization +
    scores.specificity +
    scores.confidenceCalibration;

  return {
    scores,
    total,
    reasoning: parsed?.reasoning ?? `判官未返回可解析 JSON，原始文本：${text.slice(0, 200)}`,
    pass: total >= JUDGE_PASS_THRESHOLD,
  };
}

/**
 * 写判官报告到 <project>/data/nexus-eval/<timestamp>-<label>.json，供人工复核。
 *
 * 注意：刻意用固定项目 data 目录（忽略 runAnalysis 的临时 LIF_DATA_DIR），
 * 否则报告会落入测试隔离的 tmpdir 被回收，丢失人工复核产物。
 */
export function writeReport(label: string, payload: unknown): string {
  const dir = resolve("./data", "nexus-eval");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(dir, `${ts}-${label}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

/** 计算单条建议引用的证据平均强度（用于 confidenceCalibration 对照）。 */
export function avgEvidenceStrength(evidenceTools: string[]): number {
  // 取证工具越多，证据越充分（粗略启发式）；映射到 0-1
  const n = evidenceTools.length;
  if (n === 0) return 0;
  if (n === 1) return 0.3;
  if (n <= 3) return 0.6;
  if (n <= 6) return 0.8;
  return 0.9;
}

const JUDGE_SYSTEM_PROMPT = `你是精益生产运营分析的资深评审专家。你的任务是评估 AI 助手给出的改善建议质量。

## 评分维度（每维 0-2 分整数，总分 10）

1. **evidenceBased（证据充分性）**：建议的 rationale 是否真实引用了取证工具的数据？
   - 2 分：每条建议都引用了具体取证结果（如"MTBF 180h"、"健康分 0.62"），非凭空臆断
   - 1 分：部分引用，但有空泛表述混入
   - 0 分：全是"建议加强管理/优化流程"套话，无数据支撑

2. **actionability（可执行性）**：actionTool 设置是否合理？
   - 2 分：有真实可执行动作时给了 actionTool；无可执行 MCP 时正确留空（不勉强）
   - 1 分：actionTool 留空但本可给，或给了模糊工具名
   - 0 分：无 MCP 时强行编造 actionTool，或该给按钮却没给

3. **prioritization（优先级排序）**：建议排序是否符合"先治根因再优化"？
   - 2 分：紧急（高影响×高执行度）排前，治本优先于治标
   - 1 分：排序基本合理但有瑕疵
   - 0 分：把治标/低影响建议排在前面，治本建议被淹没

4. **specificity（具体性）**：是否具体到设备/参数/数值？
   - 2 分：点名具体设备（主轴/模具）、具体参数（温度185℃）、具体阈值
   - 1 分：部分具体，部分模糊
   - 0 分：全是"检查设备/优化工艺"泛泛之谈

5. **confidenceCalibration（置信度校准）**：confidence 值是否与证据强度匹配？
   - 若期望证据强度低（如 0.4，crisis 场景证据分散）但建议 confidence 普遍 >0.9 → 扣分（过度自信）
   - 若证据充分（强度 >0.7）但 confidence <0.5 → 扣分（过度保守）
   - 2 分：置信度与证据强度匹配
   - 1 分：略有偏差
   - 0 分：明显失准

## 输出要求
返回 JSON：{ scores: {...5 维...}, reasoning: "中文扣分说明" }。只返回 JSON，不要其他文字。`.trim();
