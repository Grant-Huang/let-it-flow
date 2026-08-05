# 27 - 0.x 阶段 API 稳定性承诺

> **生效版本**：`@meso.ai/let-it-flow@0.3.2+`  
> **政策版本**：1.0  
> **机器可读清单**：`src/stability.ts`（从主入口导出 `STABILITY_POLICY` / `MAIN_EXPORT_STABILITY` 等）

## 27.1 背景

SemVer 对 `0.y.z` 的默认解读是「任何 minor 都可能 breaking」。但 let-it-flow 已作为 npm 包被下游集成（SDK、HTTP、Harness、Skill），若不在 **0.x 阶段** 明确哪些面可以依赖，消费者只能猜。

本政策在 **1.0.0 之前** 即引入三级稳定性，与 Node.js / React 等生态的常见做法一致：**0.x ≠ 全部不稳定**。

## 27.2 稳定性等级

| 等级 | 标识 | 0.x 承诺 |
|------|------|----------|
| **Stable 稳定** | ✅ | 仅 additive 扩展；破坏性变更须先 `@deprecated` **至少一个小版本**，CHANGELOG 明示；**移除推迟至 1.0.0** |
| **Evolving 演进** | 🔄 | minor 内可调整行为或 TypeScript 签名；须 CHANGELOG；优先 additive，避免 silent break |
| **Experimental 实验** | 🧪 | 无兼容承诺；可在任意 patch/minor 变更或移除 |

### 与版本号的关系（0.x 阶段）

| 变更类型 | 版本 bump | 适用面 |
|----------|-----------|--------|
| Bug fix，不改变稳定面契约 | **Patch** `0.y.z` | Stable / Evolving |
| 稳定面 **additive**（新字段 optional、新导出） | **Minor** `0.y.0` | Stable |
| 稳定面 **breaking**（未经 deprecate） | **不允许**；须先 deprecate → 下 minor 再移除（移除仍等到 1.0.0） | Stable |
| 演进面 breaking | **Minor** + CHANGELOG | Evolving |
| 实验面任意变更 | Patch 或 Minor | Experimental |

> **1.0.0 的含义**：平台进入「默认 Stable」阶段；届时 Evolving 面会复审是否升格，Experimental 未毕业者可能移除。

## 27.3 入口与职责

| 入口 | 受众 | 说明 |
|------|------|------|
| `@meso.ai/let-it-flow` | SDK / Skill 作者 | 主入口；下文 §27.4 |
| `@meso.ai/let-it-flow/runtime` | 装配者（自建服务） | 下文 §27.5 |
| HTTP（`createApp()`） | 前端 / 集成方 | 下文 §27.6 |
| SSE 事件信封 | 与 `@meso.ai/types` 对齐 | **Stable**（见 [08-task-streaming.md](08-task-streaming.md)） |

## 27.4 主入口 `@meso.ai/let-it-flow` — Stable ✅

以下为核心契约，**可放心依赖**：

### SDK

- `LetItFlow`, `LetItFlowConfig`
- `execute()` 流式事件序列（`StreamEvent` / `InternalEvent` 及 payload helper）
- `approve` / `reject` / `clarify` HITL 控制面

### 流式协议

- `makeEvent`, `toSSE`, `serializeSSEData`, `STREAM_EVENT_TYPES`
- 全部 `*Payload` helper（`phasePayload`, `toolCallPayload`, `confirmGatePayload` 等）
- R3 **extension 预设**：`EXTENSION_PRESETS`, `resolveExtensionAlias`, `isPresetExtension` 及 typed payload helper

### Harness / Skill（ETCLOVG）

- `runReactHarness`, `HarnessConfig`, `HarnessResult`, `StepTrace`
- `PreconditionRegistry`, `GovernanceChain`, `Precondition`, `GovernanceRule`
- `createSkill`, `SkillConnector`, `StepCtx`, `StepsInput`, `DynamicStepsFn`
- **Skill 间数据流**：`StepCtx.resolveRef`, `StepsInput.priorCallId` / `priorKind`（0.3.0+）

### 工具与证据

- `ToolRegistry`, `FlowConnector`, `ToolResult`, `ToolTier`, `ExecutionContext`, `ToolManifest`
- `EvidenceEnvelope` 及 `wrapEvidence` / `isEvidenceEnvelope` / `evidenceStrength` / `summarizeEvidence`
- `IKnowledgeProvider`, `KnowledgeSnippet`, `KnowledgeQuery`, `wrapSnippetAsEvidence`
- `createKnowledgeBaseTool`

### 任务运行时

- `TaskRegistry`, `TaskRuntime`, `TaskRunnerHooks`, `TaskMeta`

完整符号列表见 `MAIN_EXPORT_STABILITY`（`src/stability.ts`）。

## 27.5 主入口 — Evolving 🔄 / Experimental 🧪

### Evolving

- **R4–R7 平台机制**：`computeStepBudget`, `DefaultTraceCompressor`, `loadPreviousContext`, `composePrepareStep`, `emitHarnessResult` 等
- **R8**：`CatalogVersionProvider`, `NoopVersionProvider`
- **传输**：`globalBroadcaster`（单例语义可能调整）
- **MCP 注册**：`McpRouter`, `McpClient`, `createMcpActionTool`, `registerMcpServerTools`, `McpKnowledgeProvider`
- **内置示例**：`ObsidianProvider`（接口 Stable，实现 Evolving）

### Experimental

（主入口暂无 Experimental 导出；实验能力放在 `runtime` 子路径。）

## 27.6 装配入口 `@meso.ai/let-it-flow/runtime`

| 等级 | 代表符号 |
|------|----------|
| ✅ Stable | `createApp`, `LlmService`, `loadConfig`, `ToolRegistry`, `runReactHarness`, `createSkill`, `SkillRegistry`, `createOrchestrator`, `FileTaskStore`, `registerBuiltinTools` |
| 🔄 Evolving | `createToolResolver`, `CompositeToolResolver`, `KpiResolver`, `McpCatalogCache`, `KpiCatalogCache`, `ensureSeedConfig`, `ConversationStore`, `registerHeavyIoTools` |
| 🧪 Experimental | `EmbeddingToolRouter`, `makeAiEmbedder`, `createLazyMcpActionTool`, `NEXUS_PORT` |

## 27.7 HTTP API

| 路由 | 等级 | 说明 |
|------|------|------|
| `GET /health` | ✅ | 健康检查 |
| `POST /api/workflows` | ✅ | 提交意图 / 工作流 |
| `GET /api/tasks`, `GET /api/tasks/:id` | ✅ | 任务元数据 |
| `GET /api/tasks/:id/stream` | ✅ | SSE 流（Stable 信封） |
| `POST /api/tasks/:id/confirm`, `POST /api/tasks/:id/clarify` | ✅ | HITL |
| `GET /api/tools` | 🔄 | 工具清单（P7） |
| `GET /api/conversations/*` | 🔄 | 多轮会话（R5） |
| `GET/PUT/POST/DELETE /api/config/*` | 🔄 | P8 配置面 |

JSON 响应统一 `{ status, data, message? }` 为 **Stable** 外壳；`data` 内字段按上表随路由等级。

## 27.8 破坏性变更流程（Stable 面）

1. **Deprecate**：在 minor 版本 JSDoc 标记 `@deprecated`，CHANGELOG 写迁移路径  
2. **共存**：至少保留 **一个完整 minor 周期**（如 0.3.x 弃用 → 最早 0.4.0 才可移除）  
3. **Remove**：稳定面符号的**物理删除**统一推迟到 **1.0.0**（除非从未发布到 npm 的私有分支）  
4. **测试**：契约测试 / `test-platform-exports` 覆盖 Stable 导出存在性  

## 27.9 消费者建议

```typescript
import {
  STABILITY_POLICY,
  MAIN_EXPORT_STABILITY,
  listExportsByStability,
} from "@meso.ai/let-it-flow";

// 仅依赖 Stable 面（CI 可断言）
const stable = listExportsByStability(MAIN_EXPORT_STABILITY, "stable");
```

- **生产集成**：只 import **Stable** 符号；锁定 `^0.3.2` 并阅读 minor CHANGELOG  
- **平台装配**：`runtime` 的 Evolving 面可用，但 minor 升级需跑集成测试  
- **Experimental**：不要进入生产路径；API 变更不保证 notice  

## 27.10 相关文档

| 文档 | 内容 |
|------|------|
| [docs/help/migration.md](help/migration.md) | 跨版本迁移 |
| [docs/08-task-streaming.md](08-task-streaming.md) | SSE 协议（Stable） |
| [docs/04-tool-protocol.md](04-tool-protocol.md) | FlowConnector（Stable） |
| [docs/15-harness-engineering.md](15-harness-engineering.md) | Harness（Stable 核心） |

## 27.11 变更本政策

- 仅 **升格**（Experimental → Evolving → Stable）可在 minor 进行，须更新 `src/stability.ts` + 本文档 + CHANGELOG  
- **降级**（Stable → Evolving）视为 breaking，须 major 计划（1.0.0 起）或 never（已 Stable 符号原则上不降级）
