# 02 - 工具解析层设计（ToolResolver）

**职责**：把 Orchestrator 产出的"语义需求"（如 `process_capability`）解析为当前企业环境里的"真实工具调用"（如 `quality.cp_cpk` 或 `mes.capability`）。这是 relos 与企业工具集松耦合（D3 决策）的具体落地。

---

## 1. 设计目标与约束

### 1.1 解决的问题

relos 只懂业务语义（"需要过程能力数据"），不懂企业有什么工具。但 LLM 最终要调的是真实工具。中间缺一层映射：

```
Orchestrator 产出："需要 process_capability 数据"
        │
        │  ❓ 企业 A 叫 quality.cp_cpk，企业 B 叫 mes.capability，企业 C 没有这个工具
        ▼
LLM 调用：toolResolver.resolve({semantic:"process_capability"}) → 真实工具
```

### 1.2 约束（来自已确认决策）

- **D3**：relos 通用不懂工具名 → resolver 在 nexusops 侧实现，不在 relos 侧
- **D4**：企业可回写工具集索引到 relos（双向）→ resolver 支持"先查索引"策略
- **D10**：语义标注在工具侧，实施时初始化 → FlowConnector 加 `semanticTags` 字段

---

## 2. 工具语义标注（D10 落地）

### 2.1 FlowConnector 扩展

现有 `FlowConnector`（`src/tools/base.ts`）已有 `evidenceMeta`、`description`、`whenToUse`。新增 `semanticTags`：

```typescript
export interface FlowConnector<TOutput = unknown> {
  // ... 现有字段 ...

  /**
   * 语义标签（新增，D10 决策落地）。
   * 描述此工具能提供哪些业务语义的数据，供 ToolResolver 索引查询。
   * 如 quality.cp_cpk 标 ["process_capability", "quality_metrics"]。
   *
   * 实施时初始化：每家企业部署时，由实施人员根据企业工具集配置。
   * 未标注的工具仍可被 LLM 兜底解析，只是慢（走 LLM 推理而非索引命中）。
   */
  readonly semanticTags?: string[];
}
```

### 2.2 语义标签词表（初始版）

建立一份受控词表（`docs/architecture/semantic-vocab.md`，待补），避免语义标签膨胀。初始词表从现有工具反推：

| 语义标签 | 描述 | 现有工具示例 |
|---|---|---|
| `oee` | OEE 综合指标 | `oee.realtime`, `oee.decompose`, `oee.trend` |
| `oee_availability` | 可用率相关 | `oee.realtime`(availability 字段), `equipment.downtime` |
| `equipment_health` | 设备健康状态 | `equipment.health`, `equipment.health_trend` |
| `equipment_reliability` | 设备可靠性（MTBF/MTTR） | `equipment.mtbf`, `equipment.failure_predict` |
| `process_capability` | 过程能力（Cp/Cpk） | `quality.cp_cpk` |
| `defect_rate` | 缺陷率 | `quality.defect_rate`, `quality.defects` |
| `causal_chain` | 因果链/根因 | `quality.five_why`, `quality.fishbone` |
| `process_deviation` | 工艺参数偏离 | `process.deviation`, `process.parameters` |
| `energy_consumption` | 能耗 | `energy.realtime`, `energy.trend` |
| `wip_level` | 在制品水位 | `material.wip`, `material.shortage` |
| `schedule_attainment` | 排产达成 | `schedule.current` |
| `cost_summary` | 成本汇总 | （skill.cost_summary） |
| `fmea` | 失效模式分析 | `process.fmea` |
| `spc_samples` | SPC 样本 | `quality.spc` |
| `shift_deviation` | 班次差异 | `oee.by_shift`, `quality.by_shift` |

**治理规则**：
- 新增语义标签需提交到词表（PR 评审）
- 一个工具可标多个标签（如 `quality.cp_cpk` 标 `["process_capability", "quality_metrics"]`）
- 标签命名：`snake_case`，业务语义（非技术实现）

### 2.3 现有工具的标注清单（迁移工作量）

基于 `apps/nexusops/tools/` 目录的现有工具，初始标注清单见 [04-mock-rules-spec.md §5](04-mock-rules-spec.md)。预估工作量：每个工具 2-5 分钟，共约 40+ 个 domain 工具。

---

## 3. ToolResolver 接口

### 3.1 核心接口

```typescript
/**
 * 语义需求 → 真实工具的解析层。
 * 三档解析策略（按优先级）：
 *   1. 索引命中（快，企业工具索引）
 *   2. LLM 推理（慢，但灵活）
 *   3. 返回 null（数据不可用，分析继续不崩溃）
 */
interface ToolResolver {
  /**
   * 把语义需求解析为真实工具调用。
   * @param need       语义需求（来自 Orchestrator 的 SemanticNeed）
   * @param context    业务上下文（含已收集证据，辅助 LLM 推理）
   * @returns          解析结果；null 表示该语义在本企业无对应工具
   */
  resolve(need: SemanticNeed, context: BizContext): Promise<ResolvedTool | null>;

  /** 批量解析（一次分析通常有多个 need，批量减少 LLM 调用）。 */
  resolveBatch(needs: SemanticNeed[], context: BizContext): Promise<ResolvedTool[]>;
}

interface ResolvedTool {
  /** 真实工具名，如 "quality.cp_cpk"。 */
  toolName: string;
  /** 映射后的入参（语义参数 → 工具实际入参）。 */
  params: Record<string, unknown>;
  /**
   * 返回字段映射（处理异构格式）。
   * 如工具返回 {cpk: 1.2}，但消费方期望 {value: 1.2}，则 fieldMap = {cpk: "value"}。
   */
  fieldMap?: Record<string, string>;
  /** 解析来源。 */
  source: "index" | "llm" | "fallback";
  /** 解析置信度（索引命中 1.0，LLM 推理 0.6-0.8）。 */
  confidence: number;
}
```

### 3.2 三档解析策略详解

```typescript
class CompositeToolResolver implements ToolResolver {
  constructor(
    private indexResolver: IndexToolResolver,    // ① 索引解析
    private llmResolver: LlmToolResolver,        // ② LLM 解析
  ) {}

  async resolve(need: SemanticNeed, ctx: BizContext): Promise<ResolvedTool | null> {
    // ① 先查索引（快）
    const indexed = await this.indexResolver.resolve(need, ctx);
    if (indexed) return indexed;  // source: "index", confidence: 1.0

    // ② 未命中 → LLM 推理（慢但灵活）
    const llmResolved = await this.llmResolver.resolve(need, ctx);
    if (llmResolved) return llmResolved;  // source: "llm", confidence: 0.6-0.8

    // ③ 都不行 → null（数据不可用）
    return null;
  }
}
```

#### 档位 ①：索引解析（IndexToolResolver）

数据源：企业工具索引。当前统一读 `data/relos-mock/tool-index.json`（由 `syncToolIndex` 在 boot 时从 registry 的 `semanticTags` 派生写出）。`IndexToolResolver` 兼容两种格式：
- **tools 格式**（`syncToolIndex` 产出，当前主用）：`{ tools: [{ name, semanticTags, ... }] }`，反推 `semantic → toolName`。
- **entries 格式**（人工初始化或 relos 回写）：`{ entries: [{ semantic, toolName, primary, fieldMap }] }`，显式映射。

```typescript
class IndexToolResolver implements ToolResolver {
  private index: Map<string, IndexEntry[]>;  // semantic → 工具列表

  async resolve(need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    const entries = this.index.get(need.semantic);
    if (!entries || entries.length === 0) return null;
    // 取置信度最高的（或第一个）
    const entry = entries[0];
    return {
      toolName: entry.toolName,
      params: this.mapParams(need, entry.paramMap),
      fieldMap: entry.fieldMap,
      source: "index",
      confidence: 1.0,
    };
  }
}

interface IndexEntry {
  toolName: string;
  /** 语义参数 → 工具入参的映射。 */
  paramMap: Record<string, string>;
  /** 工具输出 → 语义字段的映射。 */
  fieldMap?: Record<string, string>;
}
```

**索引文件格式**（两种兼容；当前主用 tools 格式，由 `syncToolIndex` 自动生成）：

```jsonc
{
  "version": "1.0",
  "enterprise": "示例企业 A",
  "entries": [
    {
      "semantic": "process_capability",
      "toolName": "quality.cp_cpk",
      "paramMap": { "line": "line", "scenarioId": "scenarioId" },
      "fieldMap": { "cpk": "cpk" }
    },
    {
      "semantic": "process_capability",
      "toolName": "mes.capability",  // 企业 B 的等价工具
      "paramMap": { "line": "equipmentId", "scenarioId": "timeRange" },
      "fieldMap": { "Cpk": "cpk", "ProcessCapability": "cp" }
    }
  ]
}
```

#### 档位 ②：LLM 解析（LlmToolResolver）

数据源：`ToolRegistry.forPlanner()`（现有方法，返回所有工具的 manifest）+ LLM 推理。

```typescript
class LlmToolResolver implements ToolResolver {
  constructor(
    private registry: ToolRegistry,
    private llm: LlmClient,
  ) {}

  async resolve(need: SemanticNeed, ctx: BizContext): Promise<ResolvedTool | null> {
    const manifests = this.registry.forPlanner(["domain"]);
    const prompt = `
      业务语义需求：${need.semantic}（${need.description ?? ""}）
      当前上下文：产线 ${ctx.line}
      可用工具清单（含 description/whenToUse/outputSchema）：
      ${JSON.stringify(manifests, null, 2)}

      请选出最匹配的工具，返回 JSON：{toolName, reason}
      若无匹配返回 {toolName: null}
    `;
    const result = await this.llm.complete(prompt);
    if (!result.toolName) return null;
    return {
      toolName: result.toolName,
      params: {},  // LLM 不负责参数映射，由调用方按需构造
      source: "llm",
      confidence: 0.7,
    };
  }
}
```

**性能考量**：LLM 解析慢（一次调用约 1-3 秒）。优化措施：
- 解析结果缓存到会话内存（同 semantic 不重复解析）
- 批量解析（`resolveBatch` 一次 LLM 调用处理多个 need）

#### 档位 ③：返回 null

```typescript
// resolve 返回 null 时，调用方（LLM 或 skill）的处理：
if (resolvedTool === null) {
  // 选项 A：在分析报告里标注"数据不可用"，分析继续
  report.addGap(`无法获取 ${need.semantic} 数据（企业无对应工具）`);
  // 选项 B：如果 need.required=true，阻塞当前 phase（由 governance 决定）
}
```

---

## 4. 企业工具索引回写（D4 双向支持）

### 4.1 回写时机

```typescript
// boot 时或定期任务
async function syncToolIndexToRelos() {
  const manifest = registry.forPlanner(["domain", "custom"]);
  // 只回写有 semanticTags 的工具
  const tagged = manifest.filter((m) => m.semanticTags && m.semanticTags.length > 0);
  await orchestrator.syncToolIndex(tagged);
}
```

### 4.2 relos 侧的消费

relos 收到工具索引后（通过 `POST /v1/expert-init/batch`，`provenance=mes_structured`）：
- 在关系图谱里建立 `<semantic> ──IMPLEMENTED_BY──> <tool>` 关系
- 下次 `getMethodology` 的 `Phase.guidance` 可带精准工具名建议（如"本企业用 `quality.cp_cpk` 获取过程能力"）
- 但这是**建议**，LLM 可不采纳（保持松耦合）

### 4.3 双向数据流

```
relos（通用业务图谱）              nexusops（企业实例）
    │                                  │
    │  ① boot: getMethodology 等       │
    │ ◄──────────────────────────────  │  查询编排知识（语义级）
    │  （返回 semantic need）           │
    │                                  │
    │  ② ToolResolver 本地映射         │
    │                                  │  semantic → 真实工具
    │                                  │  （先查本地索引）
    │                                  │
    │  ③ 定期回写工具索引              │
    │ ◄──────────────────────────────  │  syncToolIndex(registry.forPlanner())
    │  （企业实际工具集 + 语义标注）    │  后台定时任务触发
    │                                  │
    │  ④ relos 学习后                  │
    │ ◄──────────────────────────────  │  下次 getMethodology 可带"该企业
    │  返回更精准的 suggestedTools      │  常用 X 工具"的精准建议
```

---

## 5. fieldMap 异构格式处理

### 5.1 问题场景

同样是"过程能力"，不同工具返回格式不同：

| 工具 | 返回格式 |
|---|---|
| `quality.cp_cpk`（nexusops mock） | `{cpk: 1.2, cp: 1.3}` |
| `mes.capability`（企业 B） | `{Cpk: 1.2, ProcessCapability: 1.3, Ppk: 1.1}` |
| `qms.spc_analysis`（企业 C） | `{indices: {cpk: 1.2, cp: 1.3}, samples: 30}` |

消费方（LLM 或报告组件）期望统一格式：`{cpk: 1.2, cp: 1.3}`。

### 5.2 fieldMap 解决方案

```typescript
// ResolvedTool.fieldMap 指定如何把工具输出映射为统一格式
const resolved: ResolvedTool = {
  toolName: "mes.capability",
  params: { equipmentId: "L01" },
  fieldMap: { "Cpk": "cpk", "ProcessCapability": "cp" },  // 工具字段 → 统一字段
  source: "index",
  confidence: 1.0,
};

// 调用后统一化
function normalizeOutput(raw: Record<string, unknown>, fieldMap?: Record<string, string>): Record<string, unknown> {
  if (!fieldMap) return raw;
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, unifiedKey] of Object.entries(fieldMap)) {
    if (rawKey in raw) normalized[unifiedKey] = raw[rawKey];
  }
  // 保留未映射的字段（防丢数据）
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in fieldMap)) normalized[k] = v;
  }
  return normalized;
}
```

### 5.3 嵌套字段映射

对于企业 C 的嵌套格式 `{indices: {cpk: 1.2}}`，fieldMap 支持 dot 路径：

```jsonc
{
  "fieldMap": {
    "indices.cpk": "cpk",
    "indices.cp": "cp"
  }
}
```

---

## 6. 与现有代码的衔接

### 6.1 evidence-map.ts 的演进

现有 `evidence-map.ts` 从 registry 动态生成"证据源地图"文本。引入 semanticTags 后增强：

```typescript
// 现有：按工具名前缀分组
// 增强：同时展示 semanticTags，让 LLM 知道每个工具的语义能力

export function buildEvidenceMap(registry: ToolRegistry): string {
  // ... 现有逻辑 ...

  for (const tool of sorted) {
    const parts: string[] = [`- ${tool.name}`];
    // 新增：显示 semanticTags
    if (tool.semanticTags && tool.semanticTags.length > 0) {
      parts.push(`[语义: ${tool.semanticTags.join(", ")}]`);
    }
    // ... 现有 meta / primary / description ...
  }
}
```

### 6.2 prepare-step 的集成

```typescript
// prepare-step 新增：把 ToolResolver 能力暴露给 LLM
async function prepareStep(state: ReActState) {
  // 当 LLM 需要"某语义数据"但不知道调哪个工具时，提供 resolve 能力
  if (state.intent.includes("需要") && state.intent.includes("数据")) {
    // 可选：注册一个 tool_resolver 工具供 LLM 调用
    state.availableTools.push({
      name: "tool_resolver",
      description: "按业务语义查询可用工具。输入 semantic 标签，返回匹配工具。",
      // execute 调用 toolResolver.resolve
    });
  }
}
```

---

## 7. 开放问题

| # | 问题 | 当前倾向 |
|---|---|---|
| Q1 | LLM 解析的缓存粒度？按 semantic 缓存，还是按 semantic+context 缓存？ | 倾向：按 semantic 缓存（context 主要影响 params，不影响 toolName 选择） |
| Q2 | 一个 semantic 对应多个工具时（如 `defect_rate` 有 `quality.defect_rate` 和 `quality.defects`），如何选？ | 倾向：索引里标 `primary: true` 的优先；都未标主则取置信度最高 |
| Q3 | 工具回写 relos 的频率？ | 倾向：boot 时一次 + 工具注册变更时触发（监听 registry 变化） |
