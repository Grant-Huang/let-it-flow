/**
 * Podcast-skill e2e 评测公共基建（@e2e，默认排除，手动触发）。
 *
 * 提供驱动 AI Content Factory 真实 ReAct 流程 + 完整事件流分析的复用函数：
 *   - runPodcastFlow：真实 bootAiContentFactory 装配 → TaskRegistry → start → join → 读事件流
 *   - extractCalledTools / extractArtifacts：从事件流解析工具调用 + 产物
 *   - extractToolErrors：遍历所有 tool_result，检查 error/governance_blocked/schema 错
 *     （这是现有 NexusOps e2e 漏掉 web_fetch bug 的关键——它只看 status=done）
 *
 * 全程真实 LLM 网络调用（读 .env key），不做 mock。
 * 录制回放：record 模式落 fixture（stepTrace + finalText），
 *          replay 模式断言链路完整（对比关键工具调用，不重跑 LLM）。
 */
import { bootAiContentFactory } from "../../apps/ai-content-factory/server/boot.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import { LlmService } from "../../src/services/llm-service.js";
import { loadConfig } from "../../src/llm/config-loader.js";
import { ensureSeedConfig } from "../../src/llm/seed.js";
import { globalEventBus } from "../../src/core/event-bus.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import type { StepTrace } from "../../src/agent/types.js";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

/** e2e 运行结果。 */
export interface PodcastResult {
  taskId: string;
  status: string;
  events: StreamEvent[];
  /** 按序调用的工具名（含重复）。 */
  calledTools: string[];
  /** 产物（口播稿/公众号文章，从 stepTrace 或 tool_result 提取）。 */
  artifacts: PodcastArtifact[];
  /** 累积的 finalText。 */
  finalText: string;
  /** stepTrace（从 react_step_trace 事件还原）。 */
  stepTrace: StepTrace[];
  /** 所有 tool_result 里检测到的错误（error/governance_blocked/schema 错）。 */
  toolErrors: ToolError[];
  /** 任务错误信息（status=error 时）。 */
  error?: string;
}

/** 提取的产物。 */
export interface PodcastArtifact {
  type: "podcast_script" | "wechat_article" | "unknown";
  sourceTool: string;
  /** 产物文本（截断到前 500 字供报告展示）。 */
  preview: string;
  fullLength: number;
}

/** tool_result 里检测到的错误。 */
export interface ToolError {
  toolName: string;
  /** 错误类型分类。 */
  kind: "schema_error" | "governance_blocked" | "tool_error" | "unknown";
  /** 原始错误信息（截断）。 */
  message: string;
}

/** 录制的 fixture（record 模式产出，replay 模式读取）。 */
export interface PodcastFixture {
  intent: string;
  recordedAt: string;
  status: string;
  calledTools: string[];
  finalText: string;
  stepCount: number;
  toolErrors: ToolError[];
}

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

/** fixture 目录。 */
const FIXTURE_DIR = resolve(process.cwd(), "tests/e2e/fixtures");

/** 计算 intent 的 hash（用作 fixture 文件名）。 */
function intentHash(intent: string): string {
  return createHash("md5").update(intent).digest("hex").slice(0, 12);
}

/** fixture 文件路径。 */
function fixturePath(intent: string): string {
  return resolve(FIXTURE_DIR, `podcast-${intentHash(intent)}.json`);
}

/**
 * 驱动 AI Content Factory 真实 ReAct 流程。
 *
 * @param intent 用户意图（如"做一期关于 AI 技术趋势的播客"）
 * @param opts.mode  record（真实跑 + 落 fixture）/ replay（读 fixture 对比，不重跑）
 * @param opts.vaultPath  Obsidian vault 路径（缺省用临时 seed 拷贝）
 */
export async function runPodcastFlow(
  intent: string,
  opts: { mode?: "record" | "replay"; vaultPath?: string; dataDir?: string } = {},
): Promise<PodcastResult> {
  const mode = opts.mode ?? "record";

  // replay 模式：读 fixture，返回空事件流（断言由调用方做）
  if (mode === "replay") {
    const path = fixturePath(intent);
    if (!existsSync(path)) {
      throw new Error(`replay 模式无 fixture：${path}；请先 record`);
    }
    const fixture = JSON.parse(readFileSync(path, "utf8")) as PodcastFixture;
    return {
      taskId: "replay",
      status: fixture.status,
      events: [],
      calledTools: fixture.calledTools,
      artifacts: [],
      finalText: fixture.finalText,
      stepTrace: [],
      toolErrors: fixture.toolErrors,
    };
  }

  // record 模式：真实跑
  if (opts.dataDir) process.env.LIF_DATA_DIR = opts.dataDir;

  // 准备 vault（缺省用临时 seed 拷贝目录）
  const vaultPath = opts.vaultPath ?? installVaultSeed();

  const runtime = await bootAiContentFactory({
    llm: getLlm(),
    vaultPath,
  });
  const registry = new TaskRegistry(undefined, runtime.taskRuntime);

  const meta = registry.start(intent);
  const taskId = meta.id;
  await registry.join(taskId);

  const finalMeta = registry.getStore().get(taskId);
  const events = registry.getStore().readSince(taskId, 0);
  const calledTools = extractCalledTools(events);
  const stepTrace = extractStepTrace(events);
  const artifacts = extractArtifacts(events, stepTrace);
  const finalText = collectText(events);
  const toolErrors = extractToolErrors(events);

  const result: PodcastResult = {
    taskId,
    status: finalMeta?.status ?? "unknown",
    events,
    calledTools,
    artifacts,
    finalText,
    stepTrace,
    toolErrors,
    error: finalMeta?.error,
  };

  // 落 fixture（供 replay）
  const fixture: PodcastFixture = {
    intent,
    recordedAt: new Date().toISOString(),
    status: result.status,
    calledTools,
    finalText: finalText.slice(0, 2000),
    stepCount: stepTrace.length,
    toolErrors,
  };
  writeFixture(intent, fixture);

  return result;
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

/** 从 react_step_trace 事件还原 stepTrace。 */
function extractStepTrace(events: StreamEvent[]): StepTrace[] {
  for (const ev of events) {
    if (ev.type !== "extension") continue;
    const p = ev.payload as { name?: string; data?: { stepTrace?: StepTrace[] } };
    if (p?.name === "react_step_trace" && Array.isArray(p.data?.stepTrace)) {
      return p.data!.stepTrace!;
    }
  }
  return [];
}

/** 拼接 text 事件 delta。 */
function collectText(events: StreamEvent[]): string {
  let out = "";
  for (const ev of events) {
    if (ev.type !== "text") continue;
    const delta = (ev.payload as { delta?: string }).delta;
    if (delta) out += delta;
  }
  return out;
}

/** 从 tool_result / stepTrace 提取产物（口播稿/公众号文章）。 */
export function extractArtifacts(events: StreamEvent[], stepTrace: StepTrace[]): PodcastArtifact[] {
  const artifacts: PodcastArtifact[] = [];
  const seen = new Set<string>();

  // 从 stepTrace 的 skill 调用结果提取
  for (const step of stepTrace) {
    for (const tc of step.toolCalls) {
      if (tc.toolName === "skill.write_podcast_script" || tc.toolName === "skill.write_wechat_article") {
        const type: PodcastArtifact["type"] =
          tc.toolName === "skill.write_podcast_script" ? "podcast_script" : "wechat_article";
        if (seen.has(type)) continue;
        seen.add(type);
        const script = extractScriptFromResult(tc.result);
        if (script) {
          artifacts.push({
            type,
            sourceTool: tc.toolName,
            preview: script.slice(0, 500),
            fullLength: script.length,
          });
        }
      }
    }
  }

  return artifacts;
}

/** 从 skill 结果对象提取文稿文本（兼容多种返回结构）。 */
function extractScriptFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // 直接是 { script: "..." } / { article: "..." }
  if (typeof r.script === "string") return r.script;
  if (typeof r.article === "string") return r.article;
  // EvidenceEnvelope 包裹：{ data: { script } } / { data: { stepResults: [{script}] } }
  const data = r.data as Record<string, unknown> | undefined;
  if (data) {
    if (typeof data.script === "string") return data.script;
    if (typeof data.article === "string") return data.article;
    const stepResults = data.stepResults;
    if (Array.isArray(stepResults)) {
      for (const sr of stepResults) {
        const s = extractScriptFromResult(sr);
        if (s) return s;
      }
    }
  }
  return undefined;
}

/**
 * 遍历所有 tool_result，检测错误（关键：现有 e2e 漏掉此检查）。
 *
 * 检测三类错误：
 *   - schema_error：output 含 ZodError 特征（invalid_type/expected/received）
 *   - governance_blocked：output 含 governance_blocked: true
 *   - tool_error：output 含 error 字段
 */
export function extractToolErrors(events: StreamEvent[]): ToolError[] {
  const errors: ToolError[] = [];
  // 先建 tool_call_id → toolName 映射
  const callIdToName = new Map<string, string>();
  for (const ev of events) {
    if (ev.type !== "tool_call") continue;
    const p = ev.payload as { id?: string; name?: string };
    if (p.id && p.name) callIdToName.set(p.id, p.name);
  }

  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    const p = ev.payload as { tool_call_id?: string; output?: string };
    const toolName = p.tool_call_id ? (callIdToName.get(p.tool_call_id) ?? "unknown") : "unknown";
    const output = p.output ?? "";

    // schema 错（ZodError 特征：JSON 形态的 code/invalid_type 组合，避免误报普通文本）
    if (/"code"\s*:\s*"invalid_type"|"received"\s*:\s*"undefined"|"expected"\s*:\s*"string"\s*,\s*"received"/i.test(output)) {
      errors.push({
        toolName,
        kind: "schema_error",
        message: output.slice(0, 300),
      });
      continue;
    }
    // skill 动态步骤错误（_skill.completed=false 且 errors 非空）
    if (/"_skill"\s*:\s*\{[^}]*"completed"\s*:\s*false[^}]*"errors"\s*:\s*\[/i.test(output)) {
      errors.push({
        toolName,
        kind: "tool_error",
        message: output.slice(0, 300),
      });
      continue;
    }
    // governance 阻断
    if (/governance_blocked["\s:]*true/i.test(output)) {
      errors.push({
        toolName,
        kind: "governance_blocked",
        message: output.slice(0, 300),
      });
      continue;
    }
    // 工具错误
    const errMatch = output.match(/"error"\s*:\s*"([^"]{0,300})"/);
    if (errMatch?.[1]) {
      errors.push({
        toolName,
        kind: "tool_error",
        message: errMatch[1],
      });
    }
  }
  return errors;
}

/** 写 fixture 到 tests/e2e/fixtures/podcast-<hash>.json。 */
function writeFixture(intent: string, fixture: PodcastFixture): void {
  const path = fixturePath(intent);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2), "utf8");
}

/** 写评测报告到 data/podcast-eval/<timestamp>-<label>.json。 */
export function writeReport(label: string, payload: unknown): string {
  const dir = resolve("./data", "podcast-eval");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(dir, `${ts}-${label}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

/**
 * 拷贝 AI Content Factory 的 kb-seed/vault 到临时目录，返回临时 vault 路径。
 * 用于 e2e 测试隔离（不污染真实 vault）。
 */
function installVaultSeed(): string {
  const seedRoot = resolve(process.cwd(), "apps/ai-content-factory/kb-seed/vault");
  const tmpVault = resolve(tmpdir(), `podcast-vault-${Date.now()}`);
  mkdirSync(tmpVault, { recursive: true });
  if (existsSync(seedRoot)) {
    copyTree(seedRoot, tmpVault);
  }
  return tmpVault;
}

/** 递归拷贝目录树。 */
function copyTree(src: string, dst: string): void {
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
