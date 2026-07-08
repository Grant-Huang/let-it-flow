# 25 - 平台流式会话能力回归建议（基于 NexusOps 实践）

> 配套文档：[08-task-streaming.md](08-task-streaming.md) SSE 协议、[15-harness-engineering.md](15-harness-engineering.md) ETCLOVG 七层模型、[23-conversational-quality-layers.md](23-conversational-quality-layers.md) 实时解读 + 证据评估、[24-conversational-streaming-style.md](24-conversational-streaming-style.md) 叙述风格、[16-nexusops.md](16-nexusops.md) NexusOps 应用层。

## 25.1 背景：为什么写这份文档

NexusOps 是 let-it-flow 平台的第一个"重型消费应用"：89 个工具、10 个业务域证据门、数千 MCP catalog 候选、多轮追问、HITL 护栏、review pass、skill 沉淀……这些真实负载把平台的流式会话管线压到了极限，也暴露了一批"应用层在反复实现、本应是平台机制"的能力。

本文是**回归清单**：把 NexusOps 中**已经成型且可复用**的设计，从应用层收回到平台内核，让后续应用（podcast / 未来其他消费端）开箱即用。每条建议都给出：**现状（应用层怎么做）→ 问题（为什么不回归会重复造轮子）→ 建议回归形态（接口/扩展点）→ 优先级**。

**核心纪律**（沿用 [15 号文档 §15.2.1](15-harness-engineering.md)）：平台只提供机制（挂钩点），应用提供内容（挂什么）。本清单的判断标准就是——**这是不是机制？** 如果是，就该回归。

## 25.2 回归清单总览

> **更新状态**（2026-07-07）：R3-R9 的平台层已全部实现（详见各章节的"实施状态"小节）。
> NexusOps 应用层的实际迁移（emit 新 name、用 `emitHarnessResult` 简化 customRunner 等）
> 需等待 [meso 包升级](26-meso-packages-extension-requirements.md) 完成后进行。

| # | 能力 | 现状 | 建议优先级 | 影响层 | 实施状态 |
|---|------|------|-----------|--------|---------|
| R1 | 推送模式（push/poll） | 平台已回归 ✅ | — | 传输 | ✅ 完成 |
| R2 | 事件广播器（EventBroadcaster） | 平台已回归 ✅ | — | 传输 | ✅ 完成 |
| R3 | 终态语义统一（extension 子类型） | 平台层已实现 ✅ | **P1** | 协议 | ✅ 平台 helper 完成；meso 包升级 + NexusOps 迁移待办 |
| R4 | 步数预算管理（StepBudgetManager） | 平台层已实现 ✅ | **P1** | E 层 | ✅ 平台完成；NexusOps 切换待办 |
| R5 | 多轮追问上下文压缩（TraceCompressor） | 平台层已实现 ✅ | **P1** | E 层 | ✅ 平台完成；NexusOps 切换待办 |
| R6 | prepareStep 细粒度钩子拆分 | 平台层已实现 ✅ | **P2** | E 层 | ✅ 平台完成；NexusOps 重构为中间件链待办 |
| R7 | 会话级摘要兜底（SessionSummary） | 平台层已实现 ✅ | **P2** | O 层 | ✅ 平台完成；NexusOps customRunner 简化待办 |
| R8 | content 驱动刷新接口（ETag/version） | 平台层已实现 ✅ | **P2** | C 层 | ✅ 平台完成；NexusOps 刷新接入待办 |
| R9 | 叙述时序交错治理（NarrationSequencer） | 平台层已实现 ✅ | **P2** | O 层 | ✅ 平台完成（默认 serial） |
| R10 | SSE 协议版本协商 | 单一 schema_version | **P3** | 协议 | ⏸ 按需再做 |

### 平台新增模块清单

- `src/agent/step-budget.ts`（R4）— `computeStepBudget` + `StepBudget` 类型
- `src/agent/trace-compressor.ts`（R5）— `DefaultTraceCompressor` + `compressTrace`（从 review-pass.ts 迁移）
- `src/agent/previous-context.ts`（R5）— `loadPreviousContext` + `extractStepTraceFromEvents`
- `src/agent/prepare-step-middleware.ts`（R6）— `composePrepareStep` + `stepBudgetWarnMiddleware`
- `src/agent/result-emitter.ts`（R7）— `emitHarnessResult` + `buildSessionSummary` + `extractFinalizeSummary`
- `src/tools/mcp/catalog-version-provider.ts`（R8）— `CatalogVersionProvider` 接口 + `NoopVersionProvider`
- `src/core/extension-presets.ts`（R3）— `EXTENSION_PRESETS` + 4 个 payload helper + 别名解析

所有新增能力都从 `src/index.ts` 统一导出，应用可直接 import 使用。

下面逐条展开。

---

## 25.3 R1 / R2：已回归的部分（基线确认）

这两条已经完成，列在这里是为了**明确边界**，避免重复劳动。

### R1：push/poll 双推送模式

**现状**：平台 `src/api/tasks.ts:48-62` 已提供 `ssePushMode` 配置，push 模式（默认）走 `EventBroadcaster` 实时广播，poll 模式兼容旧行为。

**NexusOps 使用方式**：直接复用，无应用层代码。

**结论**：✅ 已回归。建议保留 poll 作为降级路径（运维兜底），但不再增加新功能。

### R2：EventBroadcaster 进程内事件广播

**现状**：平台 `src/core/event-broadcaster.ts:22-91` 已提供按 taskId 隔离的 pub/sub，顺序触发，支持终态通知。

**关键设计**（`event-broadcaster.ts:140-145`）：
- broadcaster.subscribe 回调只往队列塞 + 唤醒，**不直接 await writeSSE**（避免慢消费阻塞生产者）
- 终态用 `onTerminal` 订阅，避免 `[DONE]` 当 StreamEvent 落盘

**结论**：✅ 已回归。这是本次回归中最有价值的一块，所有后续建议都建立在这个基线之上。

---

## 25.4 R3：终态语义统一（extension 子类型规范）— **P1**

### 现状

平台 SSE 协议（`src/core/stream-events.ts:32-56`）定义了 9 种事件类型，其中 `extension` 是"万能袋"：`{ name, version, data }`，name 由应用自由定义。

NexusOps 在 extension 里塞了 **10 种子类型**：

| name | 含义 | 是否通用 |
|------|------|---------|
| `confirm_gate` | HITL 确认门 | ✅ 通用 |
| `clarification_required` | Guardrail 澄清 | ✅ 通用 |
| `rejected` | 意图越界拒绝 | ✅ 通用 |
| `precondition_unmet` | 证据不足 | ✅ 通用（V 层） |
| `nexus_artifacts` | core.deliver 产物 | ✅ 通用（产物展示） |
| `react_result` | ReAct 收尾摘要 | ✅ 通用（O 层） |
| `react_step_trace` | 完整轨迹持久化 | ✅ 通用（多轮追问） |
| `review_report` | review pass 审计 | ⚠️ 通用但可选 |
| `skill_candidates` | skill 挖矿候选 | ⚠️ 通用但可选 |
| `nexus_recommendations` | 结构化建议卡 | ❌ NexusOps 业务 |

### 问题

- 前 7 种在**任何 ReAct 应用**里都会出现，但每个应用都自己定 name + version + data schema，前端（如 `renderExtension.tsx`）要为每个应用写一份渲染逻辑。
- `nexus_recommendations` 是 NexusOps 业务专属，**不该回归**（保持应用层）。

### 建议回归形态

在平台层定义**推荐子类型契约**（不强制，应用可扩展）：

```typescript
// src/core/extension-events.ts（新增）
export const EXTENSION_PRESETS = {
  confirm_gate: {
    version: "1.0",
    schema: { gateId: "string", prompt: "string", options: "string[]?", detail: "object?" },
  },
  precondition_unmet: {
    version: "1.0",
    schema: { finishReason: "string", finalText: "string?", missingDomains: "string[]?" },
  },
  artifacts: {  // 原 nexus_artifacts，去掉前缀
    version: "1.0",
    schema: { items: "Array<{type, title, description?}>" },
  },
  react_result: {
    version: "1.0",
    schema: { finishReason: "string", stepCount: "number", usage: "object" },
  },
  step_trace: {  // 原 react_step_trace，供多轮追问
    version: "1.0",
    schema: { stepTrace: "StepTrace[]", finalText: "string" },
  },
} as const;

// 平台提供 helper：构造 + 类型校验
export function makeExtension<K extends keyof typeof EXTENSION_PRESETS>(
  name: K,
  data: unknown,
): ExtensionPayload { ... }
```

**前端收益**：`@meso.ai/ui/runtime` 的 `StreamState` 只需认这 5 个预设子类型，跨应用复用渲染逻辑。

**优先级**：P1。这是**前端复用的最大障碍**——只要 extension 契约不统一，每个应用的前端就得从头写。

---

## 25.5 R4：步数预算管理（StepBudgetManager）— **P1**

### 现状

NexusOps 在 `prepare-step.ts:182-186` 自己实现了"步数预警"：

```typescript
// apps/nexusops/server/prepare-step.ts:182-186
if (maxSteps && ctx.stepNumber >= Math.ceil(maxSteps * 0.8)) {
  const remaining = maxSteps - ctx.stepNumber + 1;
  const warnText = `## 步数预警（已用 ${ctx.stepNumber}/${maxSteps}）\n剩余约 ${remaining} 步。请评估：...`;
  result.system = result.system ? `${result.system}\n\n${warnText}` : warnText;
}
```

而 `preconditions.ts:263-295` 的 `collectEveryStepReminders` 也依赖 `stepRatio`（`stepNumber / maxSteps`）做 **40/40/20 三级分级**：

```typescript
// apps/nexusops/server/preconditions.ts:263-295（简化）
if (stepRatio < 0.4) return all;        // 早期：全量提示
if (stepRatio < 0.8) return focused;    // 中期：聚焦相关
return top2;                            // 后期：强制收口 top-2
```

### 问题

- **步数预算**是任何 ReAct 应用的通用诉求：步数用完前要收口、资源紧张时要聚焦、超预算要降级。
- NexusOps 把这个逻辑混在 `prepareStep` 里，**和应用层的 preconditions 逻辑耦合**。下一个应用（如 podcast 的多步生成）要么重写一遍，要么抄一份。
- `maxSteps` 当前是 `stopPolicy` 的字段，但**预算消耗感知**（已用多少、剩多少、是否进入收口区）没有平台抽象。

### 建议回归形态

平台提供 `StepBudget` 计算工具（纯函数，不耦合 harness 内部）：

```typescript
// src/agent/step-budget.ts（新增）
export interface StepBudget {
  total: number;
  used: number;       // = stepNumber
  remaining: number;
  ratio: number;      // used / total
  phase: "ramp_up" | "focus" | "wrap_up";  // 三阶段
}

export function computeStepBudget(stepNumber: number, maxSteps: number): StepBudget {
  const ratio = stepNumber / maxSteps;
  return {
    total: maxSteps,
    used: stepNumber,
    remaining: maxSteps - stepNumber + 1,
    ratio,
    phase: ratio < 0.4 ? "ramp_up" : ratio < 0.8 ? "focus" : "wrap_up",
  };
}
```

并扩展 `PrepareStepContext` 把 budget 透传给应用：

```typescript
// src/agent/types.ts（扩展）
export interface PrepareStepContext {
  steps: StepTrace[];
  stepNumber: number;
  intent: string;
  budget?: StepBudget;  // 新增：平台计算好，应用直接用
}
```

**应用层收益**：NexusOps 的 `prepare-step.ts` 和 `preconditions.ts` 不再自己算 ratio / phase，直接读 `ctx.budget.phase`。40/40/20 分级变成平台默认策略，应用可覆盖阈值。

**优先级**：P1。这是 NexusOps 最值得回归的"机制"——纯函数、零副作用、所有 ReAct 应用都需要。

---

## 25.6 R5：多轮追问上下文压缩（TraceCompressor）— **P1**

### 现状

NexusOps 在 `boot.ts:1017-1042` 的 `resolvePreviousContext` 里自己实现了多轮追问上下文压缩：

- 从 parentTask 的 `react_step_trace` extension 读取上一轮完整轨迹
- 用 `compressTrace` 把每步的 thought 截断到 200 字
- 拼成 `{ intent, traceDigest, finalText }` 喂给 `buildUserContent`

平台 `react-harness.ts:339-353` 的 `buildUserContent` 只负责**拼接**，不负责压缩：

```typescript
// src/agent/react-harness.ts:339-353
function buildUserContent(intent, previousContext) {
  return [
    "## 上一轮分析（已压缩）",
    `意图：${previousContext.intent}`,
    `轨迹：\n${previousContext.traceDigest}`,  // ← 应用层要自己生成 digest
    `结论：${previousContext.finalText}`,
    "",
    "## 本轮追问",
    intent,
  ].join("\n");
}
```

### 问题

- **压缩策略**（thought 截断到多少字、保留哪些工具调用、是否摘要工具结果）是通用机制，NexusOps 截断到 200 字，下一个应用可能想截断到 400 字或用 LLM 摘要。
- 当前每个应用都得自己写 `compressTrace` + 自己从 `react_step_trace` 反序列化，**重复实现且易错**。
- `previousContext` 的**来源**（从哪个 task 读、读哪个 extension）也没有平台抽象，应用层直接操作 taskStore。

### 建议回归形态

平台提供压缩策略接口 + 默认实现：

```typescript
// src/agent/trace-compressor.ts（新增）
export interface TraceCompressor {
  compress(steps: StepTrace[], finalText: string): TraceDigest;
}

export interface TraceDigest {
  intent?: string;
  traceDigest: string;   // 已格式化的字符串（喂给 LLM）
  finalText: string;
}

// 默认实现：截断策略
export class DefaultTraceCompressor implements TraceCompressor {
  constructor(private opts: { thoughtMaxChars?: number; keepToolResults?: boolean }) {}
  compress(steps, finalText): TraceDigest { ... }
}
```

并扩展 `HarnessConfig`：

```typescript
// src/agent/types.ts（扩展）
export interface HarnessConfig {
  ...
  previousContext?: TraceDigest;          // 改：直接接收已压缩的 digest
  traceCompressor?: TraceCompressor;      // 新增：应用可注入自定义压缩
}
```

平台再提供一个**跨任务读取 + 压缩**的 helper（从 `react_step_trace` extension 反序列化）：

```typescript
// src/agent/previous-context.ts（新增）
export async function loadPreviousContext(
  taskStore: TaskStore,
  parentTaskId: string,
  compressor: TraceCompressor,
): Promise<TraceDigest | undefined> { ... }
```

**应用层收益**：NexusOps 的 `resolvePreviousContext` 从 ~25 行简化到 1 行调用；压缩阈值通过配置注入。

**优先级**：P1。多轮追问是 ReAct 应用的标配，不该让每个应用重写。

---

## 25.7 R6：prepareStep 细粒度钩子拆分 — **P2**

### 现状

平台 `HarnessConfig.prepareStep` 是**单一钩子**，所有"每步前要做的事"都塞在这里。

NexusOps 在 `prepare-step.ts:126-190` 的 `prepareStep` 实现里**集中了 5 个职责**：

1. 首步方法论指导注入（Orchestrator 查询 + LLM 意图分类）
2. 动态裁工具（识别主导域后裁剪）
3. every_step precondition 提示注入
4. 收尾意图检测 + 证据充分性评估（语义级 LLM）
5. 步数预警（80% 收口提示）

NexusOps 在注释里明确写了"**集中在一个 prepareStep 里实现，见计划决策 #2**"（`prepare-step.ts:4-5`）。

### 问题

- 单一钩子导致职责耦合：改一个职责要动整个函数，测试要 mock 全部依赖。
- **顺序敏感**：5 个职责的执行顺序是隐式的（先方法论 → 再裁工具 → 再注入提示 → 再评估证据 → 最后步数预警），下一个应用要插入新职责时容易踩坑。
- 平台没有"标准化钩子链"概念，每个应用都把 prepareStep 写成大杂烩。

### 建议回归形态

**不强行拆分**（NexusOps 决策 #2 有道理：集中便于顺序控制），但平台提供**可组合的中间件模式**：

```typescript
// src/agent/prepare-step.ts（新增）
export type PrepareStepMiddleware = (ctx: PrepareStepContext, next: () => Promise<PrepareStepResult | undefined>) => Promise<PrepareStepResult | undefined>;

export function composePrepareStep(middlewares: PrepareStepMiddleware[]) {
  return async (ctx: PrepareStepContext): Promise<PrepareStepResult | undefined> => {
    let result: PrepareStepResult | undefined;
    let i = 0;
    const next = async () => {
      if (i >= middlewares.length) return undefined;
      const mw = middlewares[i++];
      result = await mw(ctx, next);
      return result;
    };
    await next();
    return result;
  };
}
```

平台提供几个**通用中间件**（应用即插即用）：

```typescript
// 平台内置中间件
export const stepBudgetWarnMiddleware: PrepareStepMiddleware = (ctx, next) => {
  const r = await next();
  if (ctx.budget?.phase === "wrap_up") {
    r.system = (r.system ?? "") + buildBudgetWarnText(ctx.budget);
  }
  return r;
};
```

**应用层收益**：NexusOps 的 5 个职责可以拆成 5 个中间件，顺序显式，单测独立。**不强制**，老的单钩子用法继续兼容。

**优先级**：P2。NexusOps 当前实现能跑，但下个应用会重复踩"顺序耦合"的坑。中间件模式是渐进式改进，不破坏现有 API。

---

## 25.8 R7：会话级摘要兜底（SessionSummary）— **P2**

### 现状

NexusOps 在 `boot.ts:627-776` 的 customRunner 里，对三种 finishReason 都调了 `emitSessionSummary`：

```typescript
// apps/nexusops/server/boot.ts:627-776（简化）
if (result.finishReason === "precondition_unmet") {
  await emitSessionSummary(emit, { kind: "precondition_unmet", intent, stepTrace, finalText });
  hooks.emit("extension", { name: "precondition_unmet", ... });
  hooks.setStatus("failed", "前置条件未满足");
  return;
}
if (result.finishReason === "error") {
  await emitSessionSummary(emit, { kind: "error", intent, error });
  hooks.emit("error", { message: result.error });
  return;
}
// 成功收尾兜底
await emitSessionSummary(emit, { kind: "success", intent, stepTrace, finalText, finalizeSummary });
hooks.emit("done", {});
```

`emitSessionSummary` 负责在 LLM 没输出文字时，把 `nexus_finalize` 的 summary 参数 emit 给用户（兜底）。

### 问题

- **终态用户可读摘要**是任何 ReAct 应用的通用诉求：用户不能看到"调完工具嘎然而止"。
- 三种 finishReason（success / precondition_unmet / error）的摘要策略是通用的，NexusOps 写了一遍，下个应用还得写。
- 平台的 `runReactHarness` 返回 `HarnessResult`，但**不负责把结果转成 SSE 事件**——这个"结果 → 事件"的桥接由 customRunner 做，每个 customRunner 都要重写。

### 建议回归形态

平台提供 `emitHarnessResult` helper（在 harness 完成后调用）：

```typescript
// src/agent/result-emitter.ts（新增）
export interface EmitResultOptions {
  emit: EmitFn;
  intent: string;
  result: HarnessResult;
  // 可选：应用自定义摘要策略
  summarize?: (result: HarnessResult) => string | undefined;
  // 可选：产物提取器（从 stepTrace 提取 core.deliver 产物）
  extractArtifacts?: (steps: StepTrace[]) => ArtifactItem[];
}

export async function emitHarnessResult(opts: EmitResultOptions): Promise<void> {
  switch (opts.result.finishReason) {
    case "precondition_unmet":
      await emitSessionSummary(opts.emit, { kind: "precondition_unmet", ... });
      opts.emit({ type: "extension", payload: { name: "precondition_unmet", ... } });
      return;
    case "error":
      ...
  }
}
```

**应用层收益**：NexusOps 的 customRunner 终态分支从 ~50 行简化到 1 行调用。

**优先级**：P2。当前 NexusOps 实现能跑，但这是"每个 customRunner 都要写一遍"的样板代码。

---

## 25.9 R8：content 驱动刷新接口（ETag/version）— **P2**

### 现状

NexusOps 的 MCP catalog 刷新（`boot.ts:417-476`）是**定时全量重拉**：

```typescript
// apps/nexusops/server/boot.ts:417-476（简化）
setInterval(async () => {
  await cache.warmup(force: true);      // 全量重拉 2850 个工具
  await kpiCache.warmup(force: true);
  await router.reload();
  await toolResolver.reload();
}, refreshIntervalMs);
```

`apps/nexusops/server/api-mcp-refresh.ts` 也提供手动强制刷新端点，但同样是全量。

### 问题

- mestar 服务端没有 ETag / version / diff 信号（见 `server-improvement-proposal.md` P1 建议），所以只能全量重拉。
- 但**"内容驱动刷新"的抽象**应该是平台机制：如果某个 MCP server 将来支持 ETag，平台应该能自动走增量刷新，而不是每个应用自己判断。
- 当前 `McpCatalogCache.warmup(force)` 只支持"全量 / 跳过"两档，**没有"如果远端变了才拉"**的中间档。

### 建议回归形态

平台扩展 `McpCatalogCache` 的刷新协议：

```typescript
// src/tools/mcp/mcp-catalog-cache.ts（扩展）
export class McpCatalogCache {
  // 新增：带版本校验的刷新
  async refreshIfChanged(): Promise<{ updated: boolean; reason: "etag" | "version" | "force" | "noop" }> {
    // 1. 先调 catalog.meta 拿 ETag / version
    // 2. 与本地缓存对比
    // 3. 变了才走 warmup(force: true)
  }
}

// 抽象接口（供 MCP server 实现侧支持时自动启用）
export interface CatalogVersionProvider {
  getCatalogVersion(): Promise<{ etag?: string; version?: string }>;
}
```

**应用层收益**：NexusOps 的定时刷新从"无脑全量"变成"有变化才刷新"，降低 mestar 压力。等 mestar 实现 ETag（`server-improvement-proposal.md` P1）后，平台和应用零改动即可启用。

**优先级**：P2。当前 mestar 不支持，但平台抽象可以先做好，等上游就绪自动生效。

---

## 25.10 R9：叙述时序交错治理（NarrationSequencer）— **P2**

### 现状

平台 `react-harness.ts:420-456` 的 `fireNarrations` 是**并发 fire-and-forget**：

```typescript
// src/agent/react-harness.ts:420-456（简化）
async function fireNarrations(toolCalls, opts) {
  await Promise.all(
    toolCalls.map((tc) =>
      streamNarrateToolCall(tc, {
        onDelta: async (delta) => {
          await opts.emit?.({ type: "text", channel: "content", payload: { delta } });
        },
      }),
    ),
  );
}
```

多个工具的解读 delta **交错下发**（工具 A 的 token 1 → 工具 B 的 token 1 → 工具 A 的 token 2 ……）。

NexusOps 通过 `disableNarration: true`（`boot.ts:618`）**完全跳过**了这个机制，靠主 LLM 自己流式叙述。

### 问题

- 交错下发在**短句（≤80 字）**时观感尚可，但长解读会让用户看到"两个解读碎片交替出现"，阅读体验差。
- 这是平台机制问题，不是应用能治理的——应用层只能选"开/关"，没法控制交错粒度。
- 未来如果 podcast 等应用想用 narration（不能用主 LLM 叙述，因为主 LLM 在生成结构化内容），就会踩这个坑。

### 建议回归形态

平台提供 `NarrationSequencer`（让多个工具解读**串行下发**，而非交错）：

```typescript
// src/agent/narrate-pass.ts（扩展）
export interface NarrationOptions {
  // 新增：下发顺序策略
  sequence?: "concurrent" | "serial";  // 默认 serial（修复交错问题）
}

// fireNarrations 改为：
async function fireNarrations(toolCalls, opts) {
  if (opts.sequence === "concurrent") {
    return Promise.all(toolCalls.map(...));  // 老行为（交错）
  }
  // serial：串行执行，每个工具的 delta 全部下发完才下一个
  for (const tc of toolCalls) {
    await streamNarrateToolCall(tc, opts);
    await opts.emit?.({ type: "text", payload: { delta: "\n" } });  // 工具间分隔
  }
}
```

**注意**：串行会增加延迟（N 个工具串行 = N 倍 narrate 时间），所以要配合**并发上限 + 批次**策略。可借鉴 `StreamCoalescer` 的思路。

**优先级**：P2。NexusOps 当前用 `disableNarration` 绕过了，但这是**平台机制的缺陷**，下个应用会重新踩。

---

## 25.11 R10：SSE 协议版本协商 — **P3**

### 现状

平台 SSE 信封（`stream-events.ts:173-184`）固定 `schema_version: "1.0"`，前端 `isCompatibleVersion` 校验。

### 问题

- 9 种事件类型 + extension 万能袋已经接近协议上限，未来增加事件类型（如 `cost_update`、`progress_bar`）需要版本协商。
- 当前是"硬编码 1.0 + 不兼容就报错"，没有协商机制。

### 建议回归形态

- 握手时客户端在 `Accept` 头或 `?schemaVersion=2` 声明支持的版本范围。
- 服务端按客户端版本选择信封格式（向后兼容）。
- 定义**版本演进策略**（minor 向后兼容 / major 破坏性）。

**优先级**：P3。当前 1.0 够用，等真正需要 2.0 时再做。先记录为技术债。

---

## 25.12 不回归的清单（明确边界）

以下 NexusOps 设计**不应回归到平台**，保持应用层：

| 能力 | 为什么不回归 |
|------|------------|
| 10 个业务域证据门（OEE/设备/质量...） | 业务内容（V 层"挂什么"），不是机制 |
| EHS 护栏规则（destructive 阻断） | 业务治理（G 层内容） |
| 六层解析管道（KpiResolver + Index + Embedding + LLM） | NexusOps 针对 mestar 的特化编排 |
| 四份缓存（module-map / tool-index / by-module / kpi-catalog） | mestar 特有的大目录策略 |
| 方法论注入（DMAIC / OEE diagnose 等 topic） | 业务知识（C 层内容） |
| `nexus_recommendations` extension | NexusOps 业务专属展示 |
| 报表模板 `/api/report-templates` | 应用路由 |

**判断标准**：如果把能力挪到平台，**其他应用（podcast / litpilot）用不上**，就保持应用层。

---

## 25.13 实施优先级与里程碑

按 P1 → P2 → P3 顺序实施，每个里程碑独立可交付。

### 里程碑 M1（P1，2 周）

| 回归项 | 工作量 | 验收标准 |
|--------|--------|---------|
| R3 extension 子类型预设 | 2 天 | `@meso.ai/ui/runtime` 认 5 个预设子类型，NexusOps 前端删除自有渲染 |
| R4 StepBudgetManager | 2 天 | NexusOps `prepare-step.ts` 删除 ratio 计算，读 `ctx.budget` |
| R5 TraceCompressor | 3 天 | NexusOps `resolvePreviousContext` 从 ~25 行简化到 1 行 |

**测试要求**：平台层新增 `tests/unit/agent/test-step-budget.ts`、`test-trace-compressor.ts`、`test-extension-presets.ts`，覆盖率 ≥85%。NexusOps 端到端回归（多轮追问 + 证据门 + 收尾）全绿。

### 里程碑 M2（P2，3 周）

| 回归项 | 工作量 | 依赖 |
|--------|--------|------|
| R6 prepareStep 中间件 | 4 天 | M1 的 StepBudget |
| R7 emitHarnessResult | 3 天 | M1 的 extension 预设 |
| R8 content 驱动刷新 | 5 天 | mestar 上游支持 ETag（可先做空接口） |
| R9 NarrationSequencer | 3 天 | 无 |

### 里程碑 M3（P3，按需）

| 回归项 | 工作量 | 触发条件 |
|--------|--------|---------|
| R10 SSE 版本协商 | 5 天 | 需要引入 2.0 事件类型时 |

---

## 25.14 风险与缓解

| 风险 | 缓解 |
|------|------|
| 回归后 NexusOps 行为变化（如 StepBudget 阈值微调） | 平台默认阈值与 NexusOps 现有硬编码**完全一致**（0.4 / 0.8），迁移期可配置覆盖 |
| extension 预设与现有 NexusOps name 冲突 | 预设 name 去掉 `nexus_` 前缀，NexusOps 迁移期兼容双 name，灰度切换 |
| TraceCompressor 压缩结果与 NexusOps 现有 digest 格式不一致 | `DefaultTraceCompressor` 完全复刻 NexusOps 现有格式，迁移期逐字节对比 |
| 中间件模式（R6）改变 prepareStep 语义 | **不破坏现有 API**，`composePrepareStep` 是新增 helper，老的单函数用法继续兼容 |
| NarrationSequencer 串行增加延迟 | 默认 `serial`，但保留 `concurrent` 选项；提供 `maxConcurrency` 批次策略 |

---

## 25.15 决策追溯表

本文档的关键决策，供后续 review：

| ID | 决策 | 理由 |
|----|------|------|
| D1 | push/poll 双模式保留 | push 是未来，poll 是降级兜底，运维价值 |
| D2 | extension 用预设而非强类型 | 保持应用扩展性，预设只是"推荐契约" |
| D3 | StepBudget 用纯函数 | 零副作用，易测试，所有 ReAct 应用复用 |
| D4 | TraceCompressor 用接口 + 默认实现 | 压缩策略可能演进（LLM 摘要），接口留扩展点 |
| D5 | prepareStep 用中间件而非拆钩子 | 渐进式，不破坏现有 API，老用法兼容 |
| D6 | emitHarnessResult 是 helper 不是 harness 内置 | 保持 harness 纯净（只返回结果），事件化由调用方决定 |
| D7 | content 驱动刷新先做空接口 | mestar 未就绪，但平台抽象先做好，上游就绪自动生效 |
| D8 | NarrationSequencer 默认 serial | 修复交错问题，concurrent 作为 opt-in |
| D9 | SSE 版本协商延后 | 1.0 够用，YAGNI |

---

## 25.16 总结

NexusOps 是 let-it-flow 平台的**压力测试样本**：它把平台推到了"重型 ReAct 应用"的极限，验证了 SSE push（R1/R2）的正确性，也暴露了 7 条需要回归的机制（R3-R9）。

**核心判断**：凡是"每个 ReAct 应用都会写一遍"的代码，就该回归平台。NexusOps 的应用层代码里，**约 30% 是平台机制的重复实现**（步数预算、上下文压缩、终态摘要、extension 构造）。回归后，NexusOps 的 customRunner 可以从当前的 ~230 行（`boot.ts:545-777`）压缩到 ~120 行，让应用层只专注业务内容（业务域、证据门、护栏、MCP 集成）。

**下一步**：确认本清单后，按 M1 → M2 → M3 顺序排期，TDD 流程开发，每个回归项配套平台单测 + NexusOps 端到端回归。
