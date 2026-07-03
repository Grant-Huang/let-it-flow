# RelOS 接入规范

> 本文档定义 NexusOps 编排知识层（Orchestrator）从 MockOrchestrator 迁移到真实 relos 服务的完整规范。
>
> **当前状态**：NexusOps 使用 `MockOrchestrator`（本地 JSON 规则，`source=mock`）。relos 尚未就绪。
>
> **目标**：relos 就绪后，按本文档步骤完成零改动迁移 —— 调用方代码（prepare-step / report-html）无需任何修改。

---

## 1. 接入概述

### Mock → Relos 替换关系

| 维度 | MockOrchestrator（当前） | RelosOrchestrator（未来） |
|---|---|---|
| 数据源 | 本地 JSON 文件（`data/relos-mock/*.json`） | relos HTTP API（Neo4j 知识图谱） |
| `source` 字段 | `"mock"` | `"relos"` / `"cache"` / `"cache_stale"` |
| 方法论质量 | 静态规则，覆盖率有限 | 动态图谱，支持企业专有规则 |
| 工具索引回写 | 写本地 `tool-index.json` | POST 到 relos `/v1/tools/sync` |
| 因果链剪枝 | 按 scenarioId + line 字符串匹配 | relos 子图查询（更精准） |

### 替换原则（零改动迁移）

调用方（`prepare-step.ts` / `report-html.ts` / `boot.ts`）只依赖 `Orchestrator` 接口，不感知具体实现。迁移只需：
1. 新增 `RelosOrchestrator` / `CacheLayer` / `FallbackChain` 三个实现文件
2. 在 `OrchestratorFactory`（`factory.ts`）内部把单层 Mock 替换为 `FallbackChain`
3. boot.ts 开启后台缓存加载 + 定时刷新

**调用方代码零改动。**

---

## 2. RelosOrchestrator 实现规范

### 构造参数

```typescript
interface RelosOrchestratorOptions {
  /** relos API 基础地址。 */
  baseURL: string;            // 如 "https://relos.internal.corp/api/v1"
  /** 鉴权密钥（API Key 或 Bearer Token）。 */
  apiKey: string;
  /** 请求超时（毫秒，缺省 5000）。 */
  timeout?: number;
  /** 重试次数（缺省 2）。 */
  retries?: number;
}
```

### 四个方法的 relos API 映射

| Orchestrator 方法 | relos API | HTTP | 说明 |
|---|---|---|---|
| `getMethodology(topic, ctx)` | `GET /v1/methodologies/{topic}?line={ctx.line}` | GET | 返回 `Methodology`（含 phases + requiredData） |
| `getCausalChain(symptom, ctx)` | `POST /v1/relations/query` | POST | body = `{ symptom, line, scenarioId }`，返回 `DecisionPackage`（含 causalLayers + fishbone） |
| `getEvidenceContract(conclusion, ctx)` | `GET /v1/contracts/{conclusion}` | GET | 返回 `EvidenceContract`（含 requiredEvidence） |
| `syncToolIndex(manifest)` | `POST /v1/tools/sync` | POST | body = `ToolManifest[]`，回写企业工具索引 |

### 错误处理 + 重试策略

- **超时**：单请求超时 `timeout`（缺省 5s），超时后返回 `null`（降级到 FallbackChain 下一层）
- **重试**：网络错误（ECONNRESET / ETIMEDOUT）重试 `retries` 次（缺省 2），指数退避（500ms → 1s → 2s）
- **4xx 不重试**：参数错误（400）/ 未授权（401）/ 未找到（404）直接返回 null，不重试
- **5xx 重试**：服务端错误（500/502/503）按重试策略处理
- **所有错误返回 null**（不抛异常），让 FallbackChain 降级到下一层（Cache → Mock）

### `source` 字段映射

relos 响应的 `source` 字段需映射到 Orchestrator 的 `source` 类型：

| relos 响应来源 | Orchestrator `source` | 说明 |
|---|---|---|
| 实时查询命中 | `"relos"` | 高可信度知识 |
| 缓存命中（未过期） | `"cache"` | 可信，标注缓存时间 |
| 缓存命中（已过期但可用） | `"cache_stale"` | 低可信度，LLM 应谨慎参考 |

---

## 3. ContextBlock 消费契约

relos 在 `getMethodology` 响应中可能返回 `ContextBlock`（Markdown 格式的上下文片段），需注入 prepare-step 的 system prompt。

### 注入规则

```typescript
// prepare-step.ts 内（未来 Phase 4 实现）
const methodology = await orchestrator.getMethodology(topic, ctx);
if (methodology?.contextBlocks) {
  for (const block of methodology.contextBlocks) {
    if (totalTokens + block.estimated_tokens <= TOKEN_BUDGET) {
      systemPrompt += `\n\n## ${block.title}\n${block.content}`;
      totalTokens += block.estimated_tokens;
    }
  }
}
```

### ContextBlock 结构

```typescript
interface ContextBlock {
  title: string;           // 上下文标题（如 "DMAIC 测量阶段注意事项"）
  content: string;         // Markdown 内容
  estimated_tokens: number; // 预估 token 数（用于预算控制）
  priority: "high" | "medium" | "low";  // 优先级（超预算时按优先级裁剪）
}
```

### token 预算控制

- system prompt 的 ContextBlock 总 token 预算：`NEXUS_CONTEXT_TOKEN_BUDGET`（缺省 2000）
- 超预算时按 `priority` 裁剪（low → medium），high 永不裁剪
- `estimated_tokens` 用于预算估算，实际 token 数以 LLM tokenizer 为准

---

## 4. DecisionPackage → CausalChain 字段映射表

relos 的 `getCausalChain` 返回 `DecisionPackage`，需映射到 Orchestrator 的 `CausalChain`：

| relos DecisionPackage 字段 | CausalChain 字段 | 转换说明 |
|---|---|---|
| `symptom` | `symptom` | 直接映射 |
| `why_chains[].layers` | `chains[].layers` | 直接映射（5Why 层级数组） |
| `why_chains[].root_cause` | `chains[].rootCause` | snake_case → camelCase |
| `why_chains[].confidence` | `chains[].confidence` | 直接映射（0-1） |
| `why_chains[].method` | `chains[].method` | 缺省 `"5why"`，relos 可能返回 `"fishbone"` / `"fault_tree"` |
| `fishbone.man/machine/...` | `fishbone.man/machine/...` | 直接映射（6M1E 分支） |
| `top_suspect` | `topSuspect` | snake_case → camelCase |
| `provenance` | （丢弃） | relos 内部溯源信息，不暴露给 LLM |
| - | `source` | 由 Orchestrator 层设置（`"relos"` / `"cache"`） |

---

## 5. Mock → Relos 替换步骤（零改动迁移）

### 步骤 1：部署 relos + seed 种子数据

1. 部署 relos 服务（Neo4j + Redis + API 服务）
2. 把 `data/relos-mock/*.json` 的规则作为种子数据导入 relos（通过 relos 的 seed CLI 或 API）
3. 验证 `GET /v1/methodologies/dmaic` 返回正确的方法论

### 步骤 2：新增三个实现文件

```
src/orchestrator/relos-orchestrator.ts   # RelosOrchestrator 实现
src/orchestrator/cache-layer.ts          # CacheLayer（本地缓存 + 过期判定）
src/orchestrator/fallback-chain.ts       # FallbackChain（降级链）
```

### 步骤 3：OrchestratorFactory 内部替换

```typescript
// factory.ts（替换前）
export function createOrchestrator(opts): Orchestrator {
  return new MockOrchestrator(opts.dataDir);
}

// factory.ts（替换后）
export function createOrchestrator(opts): Orchestrator {
  const mock = new MockOrchestrator(opts.dataDir);
  const relos = new RelosOrchestrator({
    baseURL: opts.relosBaseURL!,
    apiKey: opts.relosApiKey!,
  });
  const cache = new CacheLayer({ ttl: opts.cacheTTL ?? 300 });
  return new FallbackChain([cache, relos, mock]);  // Cache → Relos → Mock
}
```

### 步骤 4：boot.ts 开启后台刷新

```typescript
// boot.ts 新增（Phase 3 已预留挂载点）
const orchestrator = createOrchestrator({
  dataDir: "data/relos-mock",
  relosBaseURL: process.env.RELOS_BASE_URL,   // 未来从 env 读
  relosApiKey: process.env.RELOS_API_KEY,
  cacheTTL: Number(process.env.RELOS_CACHE_TTL ?? "300"),
});
// 后台定时刷新缓存（缺省 5 分钟）
setInterval(() => orchestrator.refresh?.(), Number(process.env.RELOS_REFRESH_INTERVAL ?? "300000"));
```

**调用方代码零改动** —— prepare-step / report-html 只调 `orchestrator.getMethodology()`，不关心底层是 Mock 还是 Relos。

---

## 6. syncToolIndex 双向同步规范

> **当前 Mock 模式**：`syncToolIndex` 把工具清单写到本地 `data/relos-mock/tool-index.json`，`IndexToolResolver` 直接读同一文件（兼容 `tools[].semanticTags` 格式反推 `semantic → toolName`）。即 Mock 模式下"回写"与"消费"在同一文件闭环，无需 relos 参与。下文描述的是未来接 relos 后的 HTTP 双向同步。

### nexusops → relos：工具清单回写

boot.ts 启动时调用 `orchestrator.syncToolIndex(manifest)`，把当前 registry 的工具清单（含 `semanticTags`）回写给 relos：

```json
// POST /v1/tools/sync body（ToolManifest[]）
[
  {
    "name": "quality.cp_cpk",
    "description": "查询过程能力指数 Cpk...",
    "whenToUse": { "triggers": ["Cpk", "过程能力"] },
    "semanticTags": ["process_capability"]
  }
]
```

**回写频率**：boot 启动时同步一次（当前实现）。未来可扩展为定时同步（每小时）或工具注册时实时同步。

### relos → nexusops：精准工具建议

relos 在 `getMethodology` 响应的 `requiredData` 中可返回 `suggestedTool`（精准工具建议）：

```json
// relos 返回的 methodology.phases[].requiredData[]
[
  {
    "semantic": "process_capability",
    "required": true,
    "suggestedTool": "quality.cp_cpk",   // relos 精准建议的工具名
    "description": "Cpk ≥ 1.33 的证据"
  }
]
```

ToolResolver 优先使用 `suggestedTool`（relos 精准建议），未提供时再走 IndexToolResolver → LlmToolResolver 兜底。

---

## 7. Shadow Mode 安全约束

### ActionBundle 只记录不执行

relos 可能返回 `ActionBundle`（建议执行的 MCP 动作）。在 Shadow Mode（影子运行）下：

- **ActionBundle 只记录到审计日志，不真实执行**
- 前端不显示执行按钮（或在 Shadow Mode 下禁用）
- 运维通过审计日志对比"relos 建议 vs 实际执行"的差异，验证 relos 建议质量

### HITL 确认门与 relos review 队列的关系

- relos 的 destructive 建议（停线 / 批量报废）必须进入 relos review 队列（人工复核）
- NexusOps 的 HITL 确认门（`requireConfirmation`）是执行前的最后一道关
- 两者关系：relos review → HITL 确认门 → 执行
- Shadow Mode 下跳过执行，但仍走 relos review（验证建议合理性）

---

## 8. 置信度治理

### provenance → confidence 映射表

relos 的 `provenance` 字段描述知识来源的可信度，需映射到 `confidence`：

| relos provenance | confidence | 说明 |
|---|---|---|
| `verified`（已验证的历史规则） | ≥ 0.9 | 高可信，可直接采信 |
| `inferred`（图谱推理得出） | 0.6 - 0.8 | 中可信，需交叉验证 |
| `mined`（数据挖矿发现） | 0.4 - 0.6 | 低可信，LLM 应谨慎参考 |
| `unknown`（来源不明） | ≤ 0.3 | 极低可信，标注警示 |

### 反馈闭环（POST /v1/relations/{id}/feedback）

当 LLM 发现某条 relos 因果规则不准确时，可调用反馈 API 修正图谱：

```json
// POST /v1/relations/{relationId}/feedback
{
  "feedback": "inaccurate",           // "accurate" | "inaccurate" | "outdated"
  "reason": "实际根因是 SOP 未更新，非刀具磨损",
  "traceId": "task-xxx-step-3"       // 关联本次分析的轨迹（供 relos 溯源）
}
```

**触发时机**：LLM 在分析中显式否定某条规则时（如"该建议不准确，因为..."），prepare-step 自动收集反馈并上报。

---

## 附：当前 MockOrchestrator 与 relos 的对齐情况

| 对齐项 | MockOrchestrator 现状 | relos 目标 | 差距 |
|---|---|---|---|
| 方法论覆盖率 | 8 个（6 full + 2 min） | 企业全部方法论 | 需企业补充专有方法论 |
| 因果规则数 | 9 条（从 scenarios.ts 翻译） | ≥100 条（历史根因沉淀） | 需导入历史 5Why 记录 |
| 子图剪枝精度 | scenarioId + line 字符串匹配 | 图谱语义查询 | relos 更精准 |
| 工具索引 | 写本地 tool-index.json | POST relos API | 格式已对齐 |
| `source` 字段 | 恒 `"mock"` | `"relos"` / `"cache"` | 接口已预留 |

迁移后，LLM 看到的 `source` 从 `"mock"` 变为 `"relos"`，会自动提升对编排知识的采信度（prepare-step 的 prompt 引导）。
