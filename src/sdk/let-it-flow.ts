import { ensureStorageDirs } from "../storage/file-store.js";
import { FileTaskStore } from "../tasks/task-store.js";
import { TaskRegistry, type TaskRuntime } from "../tasks/registry.js";
import { createDefaultToolRegistry } from "../executor/default-tools.js";
import {
  registerBuiltinTools,
  registerHeavyIoTools,
  createTavilyProvider,
} from "../tools/index.js";
import { SubprocessAdapter } from "../tools/heavy-io/subprocess-adapter.js";
import type { HeavyIoConfig } from "../tools/heavy-io/provider.js";
import { LlmService } from "../services/llm-service.js";
import { getArtifactsDir } from "../core/config.js";
import {
  makeEvent,
  channelOf,
  type StreamEvent,
  type StreamEventType,
  type EventTypePayloadMap,
} from "../core/stream-events.js";

/**
 * Let-it-Flow SDK 配置（进程内形态）。
 * 默认装配真实 runtime（planner + executor + 内置工具 + 重 IO domain 工具）。
 */
export interface LetItFlowConfig {
  /** Planner / LLM 节点用的模型标识（如 "openai/gpt-4o"；缺省由 LlmService 角色映射决定）。 */
  plannerModel?: string;
  /** 搜索 provider 偏好（"tavily" / "native"；实际由 tavilyApiKey 决定）。 */
  searchProvider?: string;
  /** OpenAI API Key（缺省从 OPENAI_API_KEY 读取；缺省时 planner 回退启发式抽取）。 */
  openaiApiKey?: string;
  /** 搜索 provider api key（Tavily；缺省走 native DuckDuckGo）。 */
  tavilyApiKey?: string;
  /** 重 IO 配置：未提供则不注册 domain 工具（仅文本子链可用）。 */
  heavyIo?: HeavyIoConfig;
}

/**
 * Let-it-Flow SDK 主入口（进程内 async generator 形态）。
 *
 * 用法：
 *   const flow = new LetItFlow({ openaiApiKey: process.env.OPENAI_API_KEY });
 *   for await (const ev of flow.execute("把 https://... 做成播客视频")) {
 *     console.log(ev.type, ev.payload);
 *     // HITL：遇到 confirm_gate 时调用
 *     if (ev.type === "extension" && ev.payload.name === "confirm_gate") {
 *       await flow.approve(runId);   // 或 flow.reject(runId)
 *     }
 *   }
 *
 * execute() 返回事件的 async generator；HITL 暂停点通过 confirm_gate 事件
 * 暴露，消费者经 approve()/reject() 在进程内释放闩锁后继续。
 */
export class LetItFlow {
  readonly config: Required<Pick<LetItFlowConfig, "plannerModel" | "searchProvider">> & LetItFlowConfig;
  private readonly registry: TaskRegistry;
  private readonly store: FileTaskStore;
  private readonly toolRegistry = createDefaultToolRegistry();
  private readonly llm: LlmService;

  constructor(config: LetItFlowConfig = {}) {
    ensureStorageDirs();
    this.config = {
      plannerModel: "openai/gpt-4o",
      searchProvider: "native",
      ...config,
    };
    this.store = new FileTaskStore();
    this.llm = new LlmService({ apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY });

    // 注册内置 core 工具
    registerBuiltinTools(this.toolRegistry, {
      llm: this.llm,
      searchProvider: config.tavilyApiKey
        ? createTavilyProvider(config.tavilyApiKey)
        : process.env.TAVILY_API_KEY
          ? createTavilyProvider(process.env.TAVILY_API_KEY)
          : undefined,
    });

    // 注册重 IO domain 工具（若配置了 heavyIo）
    const heavy = config.heavyIo ?? buildHeavyIoConfigFromEnv();
    if (heavy) {
      const adapter = new SubprocessAdapter(heavy);
      registerHeavyIoTools(this.toolRegistry, { adapter, llm: this.llm, config: heavy });
    }

    const runtime: TaskRuntime = { llm: this.llm, toolRegistry: this.toolRegistry };
    this.registry = new TaskRegistry(this.store, runtime);
  }

  /** 工具注册表（高级用法：注册自定义工具）。 */
  get tools() {
    return this.toolRegistry;
  }

  /**
   * 执行一个意图，返回事件流（async generator）。
   *
   * 流程：start(intent) 启动 runner（后台），随后从 store 轮询新事件并 yield，
   * 直到任务进入终态（done/error/aborted/failed）。
   *
   * HITL：遇到 confirm_gate / clarification_required 事件时，消费者调用
   * approve()/reject()/clarify() 释放闩锁，本生成器继续产出后续事件。
   *
   * @param intent 用户意图
   * @param extraConfig 透传给 task.config（可选）
   */
  async *execute(intent: string, extraConfig: Record<string, unknown> = {}): AsyncGenerator<StreamEvent> {
    const meta = this.registry.start(intent, extraConfig);
    const runId = meta.id;

    let lastSeq = 0;
    // 轮询 store 的新事件直到终态
    while (true) {
      const cur = this.store.get(runId);
      const status = cur?.status;
      const events = this.store.readSince(runId, lastSeq);
      for (const ev of events) {
        lastSeq = ev.seq;
        yield ev;
      }
      if (status && isTerminalStatus(status)) {
        return;
      }
      // 短暂等待，避免 busy-loop（事件产出是突发式）
      await sleep(15);
    }
  }

  /**
   * 批准当前 HITL 确认门（进程内释放闩锁）。
   * @param runId execute() 返回的 taskId
   * @param params modify 模式下的修改参数（可选）
   */
  async approve(runId: string, params?: Record<string, unknown>): Promise<void> {
    await this.registry.confirm(runId, { decision: "approve", params });
  }

  /**
   * 拒绝当前 HITL 确认门（任务中止）。
   */
  async reject(runId: string): Promise<void> {
    await this.registry.confirm(runId, { decision: "reject" });
  }

  /**
   * 修改参数后继续（modify 模式）。
   */
  async modify(runId: string, params: Record<string, unknown>): Promise<void> {
    await this.registry.confirm(runId, { decision: "modify", params });
  }

  /**
   * 补充澄清信息（guardrail clarification_required 后调用）。
   */
  async clarify(runId: string, message: string): Promise<void> {
    await this.registry.submitClarification(runId, { message });
  }

  /** 直接发射一个事件到任务流（高级用法）。 */
  emit<T extends StreamEventType>(
    runId: string,
    type: T,
    payload: EventTypePayloadMap[T],
  ): StreamEvent {
    return this.store.append(runId, makeEvent(runId, type, payload, channelOf(type)));
  }
}

/** 从环境变量构建 HeavyIoConfig（与 api/app.ts 一致）。 */
function buildHeavyIoConfigFromEnv(): HeavyIoConfig | null {
  const repoRoot = process.env.LIF_AICF_REPO_ROOT;
  if (!repoRoot) return null;
  return {
    repoRoot,
    pythonBin: process.env.LIF_PYTHON_BIN ?? "python3",
    ttsPythonBin: process.env.LIF_TTS_PYTHON_BIN ?? process.env.LIF_PYTHON_BIN ?? "python3",
    artifactsDir: getArtifactsDir(),
    rewriteBackend: (process.env.LIF_REWRITE_BACKEND as "ollama" | "openai") ?? "ollama",
    ollamaRewriteModel: process.env.LIF_OLLAMA_MODEL,
  };
}

function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted" || status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
