import { ensureStorageDirs } from "../storage/file-store.js";
import { FileTaskStore } from "../tasks/task-store.js";
import { TaskRegistry, type TaskRuntime } from "../tasks/registry.js";
import { createDefaultToolRegistry } from "../executor/default-tools.js";
import {
  registerBuiltinTools,
  createTavilyProvider,
} from "../tools/index.js";
import { LlmService } from "../services/llm-service.js";
import { loadConfig } from "../llm/config-loader.js";
import { ensureSeedConfig } from "../llm/seed.js";
import type { ConsumerTemplate } from "../planner/consumer-template.js";
import {
  makeEvent,
  channelOf,
  type StreamEvent,
  type StreamEventType,
  type EventTypePayloadMap,
} from "../core/stream-events.js";

/**
 * Let-it-Flow SDK 配置（进程内形态）。
 *
 * 内核只装配 core.* 通用工具；业务工具（podcast 等）和业务模板由消费应用
 * 显式注册（见 examples/podcast-generator/sdk-demo.ts）。
 */
export interface LetItFlowConfig {
  /** Planner / LLM 节点用的模型标识（如 "openai/gpt-4o"；缺省由 LlmService 角色映射决定）。 */
  plannerModel?: string;
  /** 搜索 provider 偏好（"tavily" / "native"；实际由 tavilyApiKey 决定）。 */
  searchProvider?: string;
  /** OpenAI API Key（缺省从 OPENAI_API_KEY 读取；缺省时 planner 回退启发式抽取）。 */
  openaiApiKey?: string;
  /** OpenAI 兼容 API 的 baseURL（如 DeepSeek https://api.deepseek.com；缺省从 OPENAI_BASE_URL 读）。 */
  openaiBaseUrl?: string;
  /** 搜索 provider api key（Tavily；缺省走 native DuckDuckGo）。 */
  tavilyApiKey?: string;
  /**
   * 消费应用注入的兜底模板（如 podcast）。
   * planner 在 LLM 选工具失败时回退这些模板；内核不内置任何业务模板。
   */
  consumerTemplates?: ConsumerTemplate[];
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
  private readonly llmService: LlmService;

  constructor(config: LetItFlowConfig = {}) {
    ensureStorageDirs();
    // P8.5：首次启动若 registry 为空，从 .env 派生 seed 配置
    ensureSeedConfig();
    this.config = {
      plannerModel: "openai/gpt-4o",
      searchProvider: "native",
      ...config,
    };
    this.store = new FileTaskStore();
    this.llmService = new LlmService({
      apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.openaiBaseUrl ?? process.env.OPENAI_BASE_URL,
      runtimeConfig: loadConfig(),
    });

    // 注册内置 core 工具（内核只装配 core.*）
    registerBuiltinTools(this.toolRegistry, {
      llm: this.llmService,
      searchProvider: config.tavilyApiKey
        ? createTavilyProvider(config.tavilyApiKey)
        : process.env.TAVILY_API_KEY
          ? createTavilyProvider(process.env.TAVILY_API_KEY)
          : undefined,
    });

    const runtime: TaskRuntime = {
      llm: this.llmService,
      toolRegistry: this.toolRegistry,
      consumerTemplates: config.consumerTemplates,
    };
    this.registry = new TaskRegistry(this.store, runtime);
  }

  /** 工具注册表（高级用法：注册自定义工具）。 */
  get tools() {
    return this.toolRegistry;
  }

  /** LLM 服务（高级用法：消费应用注册 domain 工具时需要）。 */
  get llm(): LlmService {
    return this.llmService;
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

function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted" || status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
