# 13 - P8 配置化与可观测性

> **定位**：MVP P0–P6 之后的工程化里程碑。把"哪个调用点用哪个模型 + 怎么调"从代码硬编码和环境变量升级为**两层可配置体系**，并为每次模型调用建立**调用级日志 + 成本统计**的可观测性。
>
> **与现有文档的关系**：
> - 接续 [09-milestones-and-todolist.md](09-milestones-and-todolist.md) §9.MVP（P0–P6 已完成骨架与重 IO 链路）
> - 不替代 [02-architecture.md](02-architecture.md) §2.8（多模型平替/RobustOutputGuard）——P8 复用其能力声明机制
> - 不冲突 [03-dag-schema.md](03-dag-schema.md) `ContentPipelineConfig.summarizeModel`（节点级覆盖）——P8 在其之上做全局默认值

---

## 13.1 现状与痛点

### 现状（P6 完成态）

| 调用点 | 文件 | 模型来源 | 可配性 |
|--------|------|---------|--------|
| planner（规划/选工具/参数抽取） | `src/planner/planner.ts` | `llm.model("planner")` | ❌ 角色硬绑，改模型需改代码或 env 全局覆盖 |
| rewrite（旁述改写 step3） | `src/tools/heavy-io/rewrite.ts` | `backend=openai` 时 `llm.model("writer")` 或 `openaiModel` 字段 | ⚠️ 半配（openai 路径有 model 字段，ollama 路径硬绑 35B） |
| translate（初译 step2） | ai-content-factory `pipeline_steps.py::step2_translate_14b` | Ollama `MODEL_14B`（Python 硬编码） | ❌ 完全不可配 |
| seam_repair（接缝修复 step3b） | `pipeline_steps.py::step3b_seam_repair` | Ollama（Python 硬编码） | ❌ |
| terminology（术语统一 step3c） | `pipeline_steps.py::step3c_terminology_pass` | Ollama（Python 硬编码） | ❌ |
| image_prompts（生图提示词 step3d） | `pipeline_steps.py::step3d_image_prompts` | Ollama `MODEL_14B`（Python 硬编码） | ❌ |

### 痛点

1. **模型切换靠改代码**：从 `gpt-4o` 换到 `deepseek-v4-pro` 要么改 `DEFAULT_MODELS`，要么改 `.env` 全局覆盖（所有角色一起变），无法"planner 用 pro、rewrite 用 flash、translate 用 14B"这种细粒度组合。
2. **Python 链路是黑盒**：step2/3b/3c/3d 走 `run_step.py` 子进程，模型在 ai-content-factory 内部硬编码，TS 层完全不可控。
3. **没有调用级可观测性**：现在只有 pino 的粗粒度日志，不知道"这次任务 planner 调了几次 LLM、每次多少 token、花了多少钱、哪一步失败"。`.env` 已有 `deepseek-v4-pro` 和 `deepseek-v4-flash` 两套，但用在哪、各花多少无从统计。

---

## 13.2 设计目标

| 目标 | 衡量标准 |
|------|---------|
| **G1 模型可注册** | 新增一个模型接入（如 Claude 3.7）只需在前端填表，不动业务代码 |
| **G2 调用点可绑定** | 6 个调用点（planner/rewrite/translate/seam_repair/terminology/image_prompts）每个都能独立选模型 + 调参 |
| **G3 全量迁移 TS 直连** | step2/3b/3c/3d 不再走 Python 子进程调 Ollama，改为 TS 层直连 LLM（仍可用本地 Ollama 作为 provider，但调度权回到 TS） |
| **G4 调用级可观测** | 每次 LLM 调用产出结构化日志（callSite/model/promptTokens/completionTokens/latencyMs/cost/error），可按 callSite/taskId/时间窗聚合 |
| **G5 向后兼容** | 现有 `.env` 配置（`OPENAI_MODEL` / `LIF_REWRITE_MODEL` 等）作为默认值兜底，不破坏现有部署 |

---

## 13.3 两层配置体系

### 13.3.1 第一层：模型接入注册表（Model Registry）

管理"我有哪些模型可用"。每个条目是一个**逻辑别名** → 具体技术参数。

```typescript
// src/llm/model-registry.ts（新增）
import { z } from "zod";

/**
 * 模型端点定义。一个 alias 对应一条可调用的模型通道。
 */
export const ModelEndpoint = z.object({
  /** 逻辑别名，全局唯一。如 "deepseek-v4-pro"、"gpt-4o"、"qwen-35b-local" */
  alias: z.string().regex(/^[a-z0-9-]+$/),
  /** provider 类型，决定如何构造 LanguageModel */
  provider: z.enum(["openai", "ollama", "azure", "anthropic", "openai-compatible"]),
  /** provider 内部的模型 id。如 "deepseek-chat"、"qwen2.5:35b" */
  modelId: z.string(),
  /** OpenAI 兼容 API 的 baseURL（provider=openai/openai-compatible 时必填） */
  baseURL: z.string().url().optional(),
  /** API Key 的环境变量名（不存明文，运行时从 process.env 读取） */
  apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  /** 结构化输出能力，决定走 RobustOutputGuard 哪条路径（见 02 §2.8） */
  structuredSupport: z.enum(["native", "weak"]).default("native"),
  /** 能力标签，调用点绑定时用于过滤可选模型 */
  capabilities: z.array(
    z.enum(["chat", "structured", "streaming", "reasoning"]),
  ).default(["chat"]),
  /** 单价（美元 / 1K token），用于成本统计。可选 */
  pricing: z.object({
    inputPer1K: z.number().nonnegative(),
    outputPer1K: z.number().nonnegative(),
  }).optional(),
  /** 备注（前端展示用，部署者填） */
  note: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type ModelEndpoint = z.infer<typeof ModelEndpoint>;
```

**示例**（对应您说的"细化到 deepseek-v4-pro / deepseek-v4-flash"）：

```json
[
  {
    "alias": "deepseek-v4-pro",
    "provider": "openai-compatible",
    "modelId": "deepseek-chat",
    "baseURL": "https://api.deepseek.com",
    "apiKeyEnv": "OPENAI_API_KEY",
    "structuredSupport": "weak",
    "capabilities": ["chat", "structured", "reasoning"],
    "pricing": { "inputPer1K": 0.0014, "outputPer1K": 0.0028 }
  },
  {
    "alias": "deepseek-v4-flash",
    "provider": "openai-compatible",
    "modelId": "deepseek-chat",
    "baseURL": "https://api.deepseek.com",
    "apiKeyEnv": "OPENAI_API_KEY",
    "structuredSupport": "weak",
    "capabilities": ["chat"],
    "pricing": { "inputPer1K": 0.00014, "outputPer1K": 0.00028 }
  },
  {
    "alias": "qwen-14b-local",
    "provider": "ollama",
    "modelId": "qwen2.5:14b",
    "baseURL": "http://localhost:11434",
    "apiKeyEnv": "OLLAMA_API_KEY",
    "structuredSupport": "weak",
    "capabilities": ["chat"]
  }
]
```

> **注意**：`provider=openai-compatible` 时走 `createOpenAI({baseURL}).chat(modelId)`（兼容模式，见现有 `LlmService.useChat`）；`provider=openai` 走 `createOpenAI()(modelId)`（Responses API）。两种路径已在 `src/services/llm-service.ts` 实现，P8 只是把"构造哪个 model"的决策权从硬编码 `DEFAULT_MODELS` 移到 registry。

### 13.3.2 第二层：调用点绑定（Call-Site Binding）

管理"哪个调用点用哪个模型 + 怎么调"。

```typescript
// src/llm/call-sites.ts（新增）

/** 全部 LLM 调用点枚举。新增调用点在此追加，禁止散落字符串字面量。 */
export const CALL_SITES = [
  "planner",        // DAG 规划（强推理）
  "rewrite",        // 旁述改写（量大，step3）
  "translate",      // 初译（step2）
  "seam_repair",    // 接缝修复（step3b）
  "terminology",    // 术语统一（step3c）
  "image_prompts",  // 生图提示词（step3d）
] as const;
export type CallSite = (typeof CALL_SITES)[number];

/**
 * 调用点 → 模型绑定。每个调用点独立配置。
 */
export const CallSiteBinding = z.object({
  callSite: z.enum(CALL_SITES),
  /** 引用第一层的 alias */
  modelAlias: z.string(),
  /** 调用参数（覆盖模型默认）。可选 */
  params: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
  }).default({}),
  /** 是否启用 RobustOutputGuard（仅 structured 能力的调用点生效） */
  robustGuard: z.boolean().default(false),
});
export type CallSiteBinding = z.infer<typeof CallSiteBinding>;
```

**示例**：

```json
[
  { "callSite": "planner",       "modelAlias": "deepseek-v4-pro",  "params": { "temperature": 0.2 } },
  { "callSite": "rewrite",       "modelAlias": "deepseek-v4-flash","params": { "temperature": 0.7 } },
  { "callSite": "translate",     "modelAlias": "qwen-14b-local",   "params": { "temperature": 0.3 } },
  { "callSite": "seam_repair",   "modelAlias": "qwen-14b-local",   "params": { "temperature": 0.3 } },
  { "callSite": "terminology",   "modelAlias": "qwen-14b-local",   "params": { "temperature": 0.2 } },
  { "callSite": "image_prompts", "modelAlias": "qwen-14b-local",   "params": { "temperature": 0.25 } }
]
```

### 13.3.3 配置解析优先级

调用点取模型时按以下顺序回退，保证向后兼容：

```
1. CallSiteBinding 显式指定 modelAlias
2. .env 调用点专用变量（LIF_PLANNER_MODEL / LIF_REWRITE_MODEL / LIF_TRANSLATE_MODEL / ...）
3. .env 全局变量（OPENAI_MODEL）
4. 代码内 DEFAULT_BINDINGS（首次启动 seed 用）
```

**回退链意义**：现有 `.env`（如 `LIF_REWRITE_MODEL=deepseek-v4-flash`）在 P8 上线后自动成为默认绑定，无需用户立刻迁移到前端配置；用户在前端配过后，前端配置覆盖 env。

---

## 13.4 5 个 LLM 步骤迁移到 TS 直连（G3）

### 13.4.1 迁移范围：仅 5 个 LLM 步骤

完整的 podcast 链路有 9 个步骤，但**只有 5 个是 LLM 调用**，其余 4 个是依赖 torch/FFmpeg 的重 IO 操作，不属于 P8 配置化范围。

#### 迁移（5 个 LLM 步骤）

| 步骤 | 现状 | P8 后 | 迁移工作量 |
|------|------|-------|-----------|
| step2 translate | `run_step.py 2` → Ollama 14B | TS 直连 LLM（用 callSite=translate 的绑定） | 中（prompt 已在 Python 里，需移植） |
| step3 rewrite | 已有 openai 路径（半配） | 统一走 callSite=rewrite 绑定 | 小（去掉 backend 分支） |
| step3b seam_repair | `run_step.py 3b` → Ollama | TS 直连 | 中 |
| step3c terminology | `run_step.py 3c` → Ollama | TS 直连 | 中（含术语表加载） |
| step3d image_prompts | `run_step.py 3d` → Ollama 14B | TS 直连（结构化输出） | 中（已有 IMAGE_PROMPT_SYS prompt） |

#### 不迁移（4 个非 LLM 步骤，永久保留 Python 子进程）

| 步骤 | 工具 | 原因 | TS 层职责 |
|------|------|------|----------|
| step4a image_gen | `createImageGenTool` | Z-Image-Turbo 是扩散模型，依赖 torch + diffusers + GPU | 仅文件中转 + 调 `run_step.py 4a`，不动 |
| step4b tts | `createTtsTool` | Qwen3-TTS 依赖 torch + transformers，Grant 音色克隆需 venv | 仅文件中转 + 调 `run_step.py 4b`，不动 |
| step5 subtitle | `createSubtitleTool` | WhisperX 语音对齐依赖 torch | 仅文件中转 + 调 `run_step.py 5`，不动 |
| step6 video_build | `createVideoBuildTool` | FFmpeg Ken Burns + crossfade 合成 | 仅文件中转 + 调 `run_step.py 6`，不动 |

**关键原则**：P8 的"配置化"只针对 LLM 调用点。step4a/4b/5/6 的 Python 子进程是**唯一实现**，不是 fallback，不会被 TS 直连替代。它们对应的工具文件（`image-gen.ts`/`tts.ts`/`text-steps.ts::createSubtitleTool`/`video-build.ts`）在 P8 中**保持不变**。

### 13.4.2 迁移策略：5 个 LLM 步骤保留 python backend 作应急切换

5 个 LLM 步骤迁移到 TS 直连后，保留 Python 子进程路径作为 `backend` 字段的**应急切换**（不是永久 fallback）。step4a/4b/5/6 不涉及此字段（它们只有 Python 一条路）。

```typescript
// 迁移后的 translate 工具示意（仅 LLM 步骤有此结构）
export function createTranslateTool(deps: {
  llm: LlmService;
  runtime: TextStepRuntime;     // 仍保留，供 backend="python" 应急
  backend?: "ts" | "python";    // 默认 ts；python 仅在 TS 路径异常时应急
}): FlowConnector<TranslateOutput>
```

**切换策略**：
- 首次上线 `backend` 默认 `ts`，保留 `python` 路径作应急（仅 5 个 LLM 步骤）
- 跑 1–2 个版本观察稳定性后，下个里程碑删除 5 个 LLM 步骤的 Python 分支
- step4a/4b/5/6 的 Python 路径是唯一实现，无 `backend` 字段，永久保留

### 13.4.3 Prompt 移植约定

每个步骤的 system prompt 当前散落在 `pipeline_steps.py`（如 `IMAGE_PROMPT_SYS`）。迁移时：

1. **逐字移植**到 `src/tools/heavy-io/prompts/<step>.md`（保持业务逻辑不变，遵守 TDD 冻结期规则）
2. 不重构、不优化 prompt 文本（避免引入质量问题）
3. 移植后跑 v4 全量测试对照产物质量

---

## 13.5 调用级可观测性（G4）

### 13.5.1 LlmCallEvent 结构

每次 LLM 调用（成功/失败）产出一条结构化日志：

```typescript
// src/llm/call-log.ts（新增）
export interface LlmCallEvent {
  /** 事件类型固定为 "llm_call" */
  type: "llm_call";
  /** 高精度时间戳 */
  timestamp: string;       // ISO 8601
  /** 调用点 */
  callSite: CallSite;
  /** 任务 id（异步任务上下文） */
  taskId?: string;
  /** DAG 节点 id（执行器内调用时） */
  nodeId?: string;
  /** 实际使用的模型 alias + provider modelId */
  modelAlias: string;
  modelId: string;
  provider: string;
  /** 输入 token 数（来自 provider 返回的 usage） */
  promptTokens?: number;
  /** 输出 token 数 */
  completionTokens?: number;
  /** 总 token 数（部分 provider 不分项，只给 total） */
  totalTokens?: number;
  /** 耗时（毫秒） */
  latencyMs: number;
  /** 估算成本（美元）。基于 registry 的 pricing 计算 */
  estimatedCostUsd?: number;
  /** 调用参数 */
  params: { temperature?: number; maxTokens?: number; topP?: number };
  /** 是否走 RobustOutputGuard */
  robustGuard: boolean;
  /** 是否成功 */
  ok: boolean;
  /** 失败时的错误类型 + 摘要（不打印完整 prompt/输出，避免泄露） */
  errorKind?: "timeout" | "auth" | "rate_limit" | "network" | "parse" | "schema" | "other";
  errorMessage?: string;   // 截断到 200 字符
  /** 重试信息 */
  retryAttempt?: number;   // 0 = 首次，1+ = 重试
}
```

### 13.5.2 埋点位置

新增 `src/llm/call-tracer.ts`，包装 `generateText` / `streamText`：

```typescript
// src/llm/call-tracer.ts（新增）
import { generateText, streamText } from "ai";
import type { LlmCallEvent } from "./call-log.js";

/**
 * 包装 AI SDK 的 generateText，自动产出 LlmCallEvent。
 * 业务代码禁止直接 import generateText，必须经过本包装（lint 规则强制）。
 */
export async function tracedGenerateText<T>(
  args: GenerateTextArgs,
  ctx: { callSite: CallSite; taskId?: string; nodeId?: string },
  hooks: { onCall: (e: LlmCallEvent) => void },
): Promise<GenerateTextResult<T>> {
  const startedAt = Date.now();
  let event: LlmCallEvent;
  try {
    const result = await generateText(args);
    event = {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: ctx.callSite,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
      modelAlias: args.__modelAlias,   // 由 planner 注入
      modelId: args.model.modelId,
      provider: args.__provider,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: computeCost(args.__pricing, result.usage),
      params: { temperature: args.temperature, maxTokens: args.maxTokens },
      robustGuard: args.__robustGuard ?? false,
      ok: true,
    };
    return result;
  } catch (e) {
    event = {
      ...buildBaseEvent(ctx, args, startedAt),
      ok: false,
      errorKind: classifyError(e),
      errorMessage: truncate(e instanceof Error ? e.message : String(e), 200),
    };
    throw e;
  } finally {
    hooks.onCall(event);
  }
}
```

**接入点**：所有走 `LlmService` 的代码（planner、rewrite、迁移后的 translate/seam_repair/terminology/image_prompts）统一改成调 `tracedGenerateText`。

### 13.5.3 落库与聚合

| 维度 | 存储 | 用途 |
|------|------|------|
| 实时流 | `LlmCallEvent` 走 `EventBus` → SSE content 通道（可选） | 前端实时显示 token/cost 计数 |
| 持久化 | 追加到 `data/tasks/<taskId>/llm_calls.ndjson`（每行一条 JSON） | 单任务回溯 |
| 聚合 | 定时（每小时）rollup 到 `data/llm_stats/<YYYY-MM-DD>.json` | 按天/调用点/模型聚合成本 |

**聚合结构**：

```json
{
  "date": "2026-06-14",
  "byCallSite": {
    "planner": { "calls": 12, "totalTokens": 45230, "costUsd": 0.13, "errors": 0 },
    "rewrite": { "calls": 8,  "totalTokens": 31200, "costUsd": 0.04, "errors": 1 }
  },
  "byModel": {
    "deepseek-v4-pro":   { "calls": 12, "totalTokens": 45230, "costUsd": 0.13 },
    "deepseek-v4-flash": { "calls": 8,  "totalTokens": 31200, "costUsd": 0.04 }
  },
  "total": { "calls": 20, "totalTokens": 76430, "costUsd": 0.17, "errorRate": 0.05 }
}
```

### 13.5.4 与现有 pino 日志的关系

- **pino**：保留，用于系统级日志（启动/请求/HITL 流转），不动业务调用埋点
- **LlmCallEvent**：独立通道，结构化字段，便于查询聚合
- 两者通过 `taskId` 关联，但不混在一行

### 13.5.5 敏感信息防护

- `LlmCallEvent` **不记录** prompt 内容、completion 文本、API key
- 只记 token 数 + 元数据
- 错误信息截断到 200 字符，且过滤掉可能含 key 的 stack trace

### 13.5.6 用户角色与字段归属

三个配置页面服务于两类用户角色。每个字段有明确的 owner，避免"谁都能改却没人维护"的混乱。

**两角色定义**：

| 角色 | 职责 | 典型字段 |
|------|------|---------|
| **部署者**（开发者+运维） | 接入模型、配密钥、调引擎参数、维护定价 | provider / apiKeyEnv / baseURL / pricing / 超时 / pythonBin |
| **使用者**（运营） | 选哪个模型干哪个活、调调用参数 | callSite → modelAlias 绑定 / temperature / maxTokens |

**字段归属矩阵**：

| 字段 | 所属页面 | 维护角色 | 使用者是否可见 | 说明 |
|------|---------|---------|--------------|------|
| provider / apiKeyEnv / baseURL / azureResourceName / azureApiVersion | 模型注册表 | 部署者 | 否（技术细节） | 一改就报错的技术字段 |
| modelId / alias / enabled | 模型注册表 | 部署者 | 是（只读展示） | 决定可用什么模型 |
| structuredSupport / capabilities | 模型注册表 | 部署者 | 否 | 影响 RobustOutputGuard 路由 |
| **pricing**（inputPer1K / outputPer1K） | 模型注册表 | **部署者** | **是（定价展示 + 成本统计依据）** | 填 provider 官方标价，随调价更新 |
| callSite → modelAlias 绑定 | 调用点绑定 | **使用者** | 是 | 选哪个模型干哪个活 |
| temperature / maxTokens / topP / robustGuard | 调用点绑定 | **使用者** | 是 | 调用参数 |
| heavyIoTimeoutMs / sseDeadlineMs / coalescerMaxBuffer 等 | 任务与流式 | 部署者 | 否 | 引擎调优参数 |
| rewriteBackend / pythonBin / ttsRefAudio 等 | 重 IO 工具链 | 部署者 | 否 | 本地环境路径 |

**关键规则**：

1. **`pricing` 是特例**：由部署者维护（需懂 provider 标价），但使用者**可见**（用于成本意识）。使用者查看实际用量统计的页面在后续里程碑实现（当前只有 ndjson 落库，无聚合 API/前端）。
2. **`alias` 即显示名**：不另设 `displayName` 字段。alias 是全局唯一的小写连字符标识符，前端列表、绑定下拉均直接显示 alias。`note` 字段保留作部署者备注。
3. **鉴权策略**：当前仅 UI 分区 + 文档约定（页面顶部有角色徽章/提示），**无后端权限校验**。未来如需强制隔离，再加登录 + 角色。

---

## 13.6 前端两个配置页面

### 页面 A：模型接入（Model Registry）

| 字段 | 控件 | 说明 |
|------|------|------|
| alias | 文本输入 | 小写连字符 |
| provider | 下拉 | openai/ollama/azure/anthropic/openai-compatible |
| modelId | 文本输入 | provider 内模型名 |
| baseURL | 文本输入 | provider=openai-compatible 时必填 |
| apiKeyEnv | 下拉（环境变量名） | 不允许直接填 key |
| structuredSupport | 单选 | native / weak |
| capabilities | 多选 | chat/structured/streaming/reasoning |
| pricing | 数字×2 | 输入/输出单价 |
| enabled | 开关 | 禁用后不可被调用点选中 |

**操作**：增/删/改/启用禁用。修改后写入 `data/config/model_registry.json`。

### 页面 B：调用点绑定（Call-Site Binding）

| 调用点 | 当前模型 | 参数 | 操作 |
|--------|---------|------|------|
| planner | deepseek-v4-pro | temp=0.2 | 编辑 |
| rewrite | deepseek-v4-flash | temp=0.7 | 编辑 |
| translate | qwen-14b-local | temp=0.3 | 编辑 |
| seam_repair | qwen-14b-local | temp=0.3 | 编辑 |
| terminology | qwen-14b-local | temp=0.2 | 编辑 |
| image_prompts | qwen-14b-local | temp=0.25 | 编辑 |

**编辑弹窗**：模型 alias 下拉（仅列 enabled=true 且 capabilities 匹配的）+ 参数表单。

**写盘**：`data/config/call_site_bindings.json`。

### 配置热加载

- 写配置文件后，通过 `EventBus` 发 `config_changed` 事件
- `LlmService` 监听该事件，清空 model 缓存（`this.cache.clear()`），下次 `model()` 调用重新按新绑定解析
- 正在执行的任务用旧配置跑完（避免中途切换模型导致输出风格不一致）

---

## 13.7 新增文件清单

```
src/llm/
├── model-registry.ts          # ModelEndpoint schema + 加载/校验
├── call-sites.ts              # CALL_SITES 枚举 + CallSiteBinding schema
├── call-log.ts                # LlmCallEvent 类型
├── call-tracer.ts             # tracedGenerateText / tracedStreamText 包装
├── cost-compute.ts            # token → 美元换算
└── config-loader.ts           # 从 data/config/*.json 加载 + env 回退
src/api/
├── config-models.ts           # GET/POST/PUT/DELETE /api/config/models（页面 A）
└── config-bindings.ts         # GET/PUT /api/config/bindings（页面 B）
src/tools/heavy-io/
└── prompts/
    ├── translate.md           # 从 pipeline_steps.py 移植
    ├── seam-repair.md
    ├── terminology.md
    └── image-prompts.md
data/config/
├── model_registry.json        # 默认从 .env seed
└── call_site_bindings.json
```

**修改的现有文件**（最小改动，仅触及 5 个 LLM 步骤相关的工具）：

- `src/services/llm-service.ts`：`model(role)` 改为 `model(callSite)`，从 `CallSiteBinding` 解析；保留 `model(role)` 重载向后兼容
- `src/planner/planner.ts`：`llm.model("planner")` 调用点不变（签名兼容，内部解析逻辑变）
- `src/tools/heavy-io/rewrite.ts`：去掉 `backend`/`openaiModel` 分支，统一走 `llm.model("rewrite")`
- `src/tools/builtin/text-steps.ts`：修改其中 `createTranslateTool`/`createSeamRepairTool`/`createTerminologyTool`/`createImagePromptsTool` 4 个工具的内部实现（去掉 `runtime.runStep()`，改用 `tracedGenerateText`），保留 `backend: "ts"|"python"` 应急字段
- 新增 `src/tools/heavy-io/prompts/{translate,seam-repair,terminology,image-prompts}.md`（rewrite 已有 prompt，不新增）

**保持不变的文件**（4 个非 LLM 步骤的工具，Python 子进程永久保留）：

- `src/tools/heavy-io/image-gen.ts`（step4a，扩散模型 torch）
- `src/tools/heavy-io/tts.ts`（step4b，Qwen3-TTS torch）
- `src/tools/builtin/text-steps.ts` 中的 `createSubtitleTool`（step5，WhisperX torch）
- `src/tools/heavy-io/video-build.ts`（step6，FFmpeg）
- `src/tools/heavy-io/subprocess-adapter.ts`（子进程适配器，上述 4 步仍依赖）
- `src/tools/heavy-io/runtime-interfaces.ts`（能力接口，上述 4 步仍依赖）

---

## 13.8 验收标准

### 配置化

- [ ] 新增一个模型（如 Claude 3.7）只在前端填表，planner 能立即切过去
- [ ] 6 个调用点每个独立绑定不同模型，互不影响
- [ ] `.env` 中 `LIF_REWRITE_MODEL` 等仍能作为默认值生效（向后兼容）
- [ ] 配置文件 schema 错误（alias 重复、modelId 空）有明确报错

### 5 个 LLM 步骤迁移

- [ ] step2/3/3b/3c/3d 这 5 个 LLM 步骤走 TS 直连后，跑 v4 全量测试产物质量不下降（与 P8.0 基线人工对比 1 个样本）
- [ ] 5 个 LLM 步骤保留 `backend="python"` 应急切换可用
- [ ] 迁移后 `run_step.py 2/3/3b/3c/3d` 仍可独立运行（ai-content-factory 不动）

### 4 个非 LLM 步骤保持不变

- [ ] step4a/4b/5/6 仍走 Python 子进程，行为与 P8.0 基线一致
- [ ] `image-gen.ts`/`tts.ts`/`createSubtitleTool`/`video-build.ts` 文件未修改

### 可观测性

- [ ] 每次模型调用产出一条 `LlmCallEvent`，字段齐全
- [ ] 单任务查询 `data/tasks/<id>/llm_calls.ndjson` 能复盘该任务的全部 LLM 开销
- [ ] 按 day/callSite/model 聚合的 `data/llm_stats/<date>.json` 正确
- [ ] 失败调用（含重试）有完整 errorKind 分类
- [ ] 敏感信息（prompt 文本/API key）不出现在任何日志/事件中

---

## 13.9 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Prompt 移植后翻译/改写质量下降 | 产物质量回归 | 逐字移植 + v4 全量对照测试；保留 python backend 切换 |
| 模型 registry 配置错误导致全站 LLM 不可用 | 平台瘫痪 | 配置加载失败时回退到 env + DEFAULT_BINDINGS；启动时校验 alias 唯一/modelId 非空 |
| TS 直连 Ollama 比子进程慢或连接不稳 | step2-3d 性能下降 | SubprocessAdapter 已有 keep-alive 池；监控 latencyMs，超阈值告警 |
| 成本统计不准（pricing 过时） | 账单对不上 | pricing 字段标注"参考价"，明确告警；提供手动对账入口 |
| 配置热加载与正在执行任务冲突 | 输出风格不一致 | 已规定：旧任务用旧配置跑完，新任务用新配置 |
| LlmCallEvent 体积大占磁盘 | 日志膨胀 | ndjson 压缩写盘；超 7 天的 `llm_calls.ndjson` 自动归档 |

---

## 13.10 里程碑拆分建议

P8 内部建议拆 4 个子阶段（每个 1–2 天），便于 TDD 渐进：

| 子阶段 | 目标 | 依赖 |
|--------|------|------|
| P8.1 | 两层配置基础设施（registry + binding + config-loader + env 回退） | 无 |
| P8.2 | 调用级可观测性（call-tracer + ndjson 落库 + 聚合） | P8.1 |
| P8.3 | 全量迁移（translate/seam_repair/terminology/image_prompts 转 TS 直连） | P8.1 |
| P8.4 | 前端两个配置页面 + 配置热加载 | P8.1, P8.2 |
| P8.5 | 多 provider 密钥管理落地（per-model key + 五 provider 并存 + seed 迁移） | P8.1 |

P8.2 与 P8.3 可并行（P8.2 改 planner/rewrite 已有路径，P8.3 改新增路径）。

---

## 13.12 P8.5：多 Provider 密钥管理落地

P8.1–P8.4 落地了 registry / binding / 热加载，但 `LlmService` 构造期仍只用单个 `createOpenAI` 实例，**完全忽略 registry 的 `provider` / `apiKeyEnv` / `baseURL` / `modelId` 五元组**。结果是无法同时用 OpenAI 官方 + DeepSeek，无法接 Anthropic。P8.5 把这个缺口补上。

### 设计要点

1. **`config-loader.resolveEndpoint(callSite)`**：在 `resolveAlias` 之上多返回一层 registry 详情（完整 `ModelEndpoint`），供 `LlmService` 按 provider 分发。
2. **`LlmService` per-provider 工厂**：构造期单 `createOpenAI` 实例改为 `providerCache`（key = `provider:baseURL`）+ `getProvider(ep)` 按 `ep.provider` 分发到对应 SDK：

   | Provider | SDK 路径 | key 来源 | baseURL |
   |----------|---------|---------|---------|
   | openai | `createOpenAI({apiKey})(modelId)` | `process.env[apiKeyEnv]` | 无（官方） |
   | openai-compatible | `createOpenAI({apiKey,baseURL}).chat(modelId)` | `process.env[apiKeyEnv]` | endpoint.baseURL |
   | ollama | `createOpenAI({apiKey:"ollama",baseURL}).chat(modelId)` | 无（本地） | endpoint.baseURL 或 `http://localhost:11434/v1` |
   | anthropic | `createAnthropic({apiKey})(modelId)` | `process.env[apiKeyEnv]` | 无 |
   | azure | `createAzure({apiKey,resourceName,...})(modelId)` | `process.env[apiKeyEnv]` | endpoint.azureResourceName |

3. **`compatModeFor(callSite)`** 取代全局 `compatMode`：按 `endpoint.provider` 判定是否走 Chat Completions（`openai-compatible` / `ollama` 为 true），未命中 registry 回退全局 `useChat`。
4. **`ModelRegistry.validateEnvKeys()`**：启动时校验所有 enabled endpoint 的 `apiKeyEnv` 是否已设环境变量，缺失打印警告（不阻止启动）。
5. **`ensureSeedConfig()`**（`src/llm/seed.ts`）：首次启动若 registry 为空，从当前 `.env` 派生一个默认 endpoint 并绑定全部 6 个调用点，让旧 `.env` 单 key 部署迁移后无需手动配置即可继续运行。
6. **call-tracer 打通成本**：业务调用方（`text-steps.ts` 的 `traceCtxFor`、`rewrite.ts`）从 endpoint 读 `provider` / `pricing` 传入 `TraceContext`，成本统计与 provider 上报自动按模型走。

### 向后兼容

- 旧 `model(role)` 重载保留，走 `legacyModel()` 兜底（registry 为空 / alias 未命中时）。
- `compatMode` getter 保留，作为未提供 callSite 的旧路径兜底。
- `.env` 单 key 部署在 seed 后仍能跑（seed 自动用全局 key 生成默认 endpoint）。

详见 [src/llm/seed.ts](../src/llm/seed.ts)、[src/services/llm-service.ts](../src/services/llm-service.ts) 的 `getProvider` / `buildProvider` / `compatModeFor`。

---

## 13.11 相关文档

- [02-architecture.md](02-architecture.md) §2.8 — 多模型平替（RobustOutputGuard），P8 复用其 `structuredSupport` 声明
- [02-architecture.md](02-architecture.md) §2.6 — API 契约（P8 新增 `/api/config/*` 端点）
- [03-dag-schema.md](03-dag-schema.md) — `ContentPipelineConfig.summarizeModel`（节点级覆盖，P8 提供全局默认）
- [09-milestones-and-todolist.md](09-milestones-and-todolist.md) — P0–P6 已完成项（P8 基于其成果）
