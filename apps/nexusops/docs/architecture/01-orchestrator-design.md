# 01 - 编排器设计（Orchestrator）

**职责**：定义编排知识源的统一接口，让分析编排逻辑从"硬编码在 skill 的 steps 里"迁移到"可配置、可替换的数据驱动"。

**核心抽象**：`Orchestrator` 接口。relos 是它的远端实现，`MockOrchestrator` 是本地兜底实现。

---

## 1. 设计目标与约束

### 1.1 解决的问题

当前分析编排逻辑散落在三个地方，彼此不统一：

| 现有位置 | 形态 | 问题 |
|---|---|---|
| `skills/dmaic.ts` 的 `steps` | 硬编码 `ctx.call("oee.realtime")` 序列 | LLM 无法动态调整；换企业要改代码 |
| `scenarios.ts` 的 `CAUSAL_CHAIN` | 硬编码 5Why + 鱼骨图 | 无法被 LLM 在编排阶段引用；只在工具调用后返回 |
| `evidence-map.ts` | 从 registry 动态生成文本 | 只有工具清单，没有"该按什么顺序调"的编排知识 |

`Orchestrator` 把这三类知识统一为同一接口的产出，让 LLM 在编排阶段就能获取。

### 1.2 约束（来自已确认决策）

- **D1**：relos 形态是关系图谱 + 规则带置信度 → `Orchestrator` 产出必须带 `confidence`
- **D2**：boot 加载缓存 + 后台更新 → `Orchestrator` 实现需支持缓存层
- **D3**：relos 通用，不懂工具名 → `Orchestrator` 产出只含语义需求，不含工具名
- **D5**：LLM 主导执行 → `Orchestrator` 产出是"指导"而非"指令"，LLM 可偏离
- **D6**：缓存失效用过期缓存，无缓存 LLM 兜底 → 降级链必须实现
- **D11**：方法论 mock 粒度 C 混合 → `getMethodology` 返回结构需支持两种粒度

---

## 2. 核心数据结构

### 2.1 顶层类型定义

```typescript
/**
 * 编排知识源抽象。
 * relos 是远端实现，MockOrchestrator 是本地兜底。
 * 所有方法返回带 confidence + source 的结构，供 LLM 调整信任度。
 */
interface Orchestrator {
  /** 按业务主题取方法论骨架（带置信度）。LLM 据此编排工具调用序列。 */
  getMethodology(topic: string, context: BizContext): Promise<Methodology | null>;

  /** 取"某结论需要什么证据"的业务契约（驱动动态 precondition）。
   *  注：precondition 证据门（EvidenceGate）按 mock 模式切换判定逻辑，
   *      详见 07 §9.2 双模式实现（mock 全开 vs MCP 关闭取证）。 */
  getEvidenceContract(conclusion: string, context: BizContext): Promise<EvidenceContract | null>;

  /** 取因果链知识（替代 mock 的 CAUSAL_CHAIN）。 */
  getCausalChain(symptom: string, context: BizContext): Promise<CausalChain | null>;

  /** 回写：把企业的工具集索引同步给 relos（双向支持的"写"方向）。 */
  syncToolIndex(manifest: ToolManifest[]): Promise<void>;
}
```

### 2.2 BizContext（业务上下文）

所有查询方法的公共入参，描述"当前分析的业务语境"。

```typescript
interface BizContext {
  /** 场景（mock 用，真实环境可缺省）。 */
  scenarioId?: "normal" | "anomaly" | "crisis";
  /** 产线/设备/工单等业务实体标识。 */
  line?: string;
  /** 当前已收集的证据快照（供 Orchestrator 判断"证据是否充分"）。 */
  collectedEvidence?: Record<string, unknown>;
  /** 分析意图（LLM 当前在想什么）。 */
  intent?: string;
}
```

**设计要点**：`BizContext` 不含工具名、不含技术参数。它是纯业务语义的上下文。relos 只消费这个，不感知 nexusops 的技术栈。

### 2.3 Methodology（方法论骨架）—— D11 C 混合粒度的载体

```typescript
interface Methodology {
  /** 方法论主题，如 "dmaic" / "oee_diagnose" / "general_analysis"。 */
  topic: string;

  /** 方法论的可信度（0-1）。LLM 据此判断是否严格遵循。 */
  confidence: number;

  /** 知识来源：relos（在线）/ cache（缓存）/ cache_stale（过期缓存）/ mock。 */
  source: "relos" | "cache" | "cache_stale" | "mock";

  /**
   * 粒度（D11 C 混合方案的核心字段）。
   *   - "full"    ：完整结构化（DMAIC/OEE 等成熟方法论），phases 含详细 goal/requiredData/guidance
   *   - "minimal" ：最小骨架（general_analysis 等开放场景），phases 只有阶段名 + 关键语义需求
   */
  granularity: "full" | "minimal";

  /** 阶段序列。granularity=full 时字段完整；minimal 时部分字段可选。 */
  phases: Phase[];

  /** 方法论级别的指导语（注入 system prompt 的软提示）。 */
  guidance?: string;
}

interface Phase {
  /** 阶段标识，如 "D" / "M" / "diagnose" / "analyze"。 */
  id: string;
  /** 阶段名称，如 "Define（定义）"。minimal 粒度时可缺省。 */
  name?: string;
  /** 阶段目标（业务语义）。minimal 粒度时可缺省。 */
  goal?: string;

  /** 该阶段需要的语义数据需求（不含工具名！）。 */
  requiredData: SemanticNeed[];

  /** 阶段级别的软提示（工具选择建议，非强制）。 */
  guidance?: string;

  /** 该 phase 规则的置信度（可选，细粒度置信度）。 */
  confidence?: number;

  /** 是否为硬阻塞点（true = 证据不足不能进入下一阶段）。 */
  blocking?: boolean;
}

interface SemanticNeed {
  /** 业务语义标识，如 "process_capability" / "oee" / "causal_chain"。 */
  semantic: string;

  /** 该需求是否为硬需求（缺失则 phase 阻塞）。 */
  required: boolean;

  /** 兜底提示（当 ToolResolver 无法解析时给 LLM 的建议）。 */
  fallbackHints?: string[];

  /** 人类可读的需求描述（注入 prompt 帮 LLM 理解）。 */
  description?: string;
}
```

### 2.4 EvidenceContract（证据契约）—— governance 校验依据

```typescript
interface EvidenceContract {
  /** 结论标识，如 "root_cause_identified" / "capability_sufficient"。 */
  conclusion: string;

  /** 支撑该结论所需的证据项。 */
  requiredEvidence: EvidenceRequirement[];

  /** 结论成立所需的最低平均置信度。 */
  minConfidence: number;

  /** 契约来源。 */
  source: "relos" | "cache" | "cache_stale" | "mock";
}

interface EvidenceRequirement {
  /** 语义需求标识（与 SemanticNeed.semantic 对齐）。 */
  semantic: string;
  /** 该证据的最低置信度（低于此值视为"证据不足"）。 */
  minConfidence: number;
  /** 该证据是否必须存在（vs 可选增强）。 */
  required: boolean;
}
```

**用途**：当 LLM 想宣布"根因已定位"时，governance 层调 `getEvidenceContract("root_cause_identified")`，校验当前 `collectedEvidence` 是否满足 `requiredEvidence`。不满足则提示 LLM 补数据。

### 2.5 CausalChain（因果链）—— 替代 CAUSAL_CHAIN

```typescript
interface CausalChain {
  /** 症状描述（与 quality.defectRate / oee.decompose 等输出对齐）。 */
  symptom: string;

  /** 5Why 逐层追问链。 */
  chains: Array<{
    method: "5why";
    layers: string[];
    rootCause: string;
    /** 该链的置信度。 */
    confidence: number;
  }>;

  /** 鱼骨图 5M1E 六分支，每分支带证据引用。 */
  fishbone: {
    man: FactorEntry[];
    machine: FactorEntry[];
    material: FactorEntry[];
    method: FactorEntry[];
    environment: FactorEntry[];
    measurement: FactorEntry[];
  };

  /** 首要嫌疑（鱼骨图中置信度最高的分支）。 */
  topSuspect?: string;

  /** 来源。 */
  source: "relos" | "cache" | "cache_stale" | "mock";
}

interface FactorEntry {
  /** 因素描述。 */
  factor: string;
  /** 该因素的置信度。 */
  confidence: number;
  /** 证据引用（指向 mock 字段或真实工具输出，增强可追溯性）。 */
  evidenceRefs?: string[];
}
```

**设计要点**：相比现有 `scenarios.ts` 的 `CausalChainData`，增加了 `confidence` 和 `source`，且 `fishbone` 从 `string[]` 升级为 `FactorEntry[]`（带置信度 + 证据引用）。这让 LLM 能区分"工程师确认的根因"和"LLM 推断的根因"。

---

## 3. MockOrchestrator 实现设计

### 3.1 数据来源

`MockOrchestrator` 从本地 JSON 文件加载规则（详见 [04-mock-rules-spec.md](04-mock-rules-spec.md)）：

```
data/relos-mock/
├── relations.json          # RelationObject 列表（因果知识）
├── methodologies-full.json # 完整结构化方法论（DMAIC/OEE 等，granularity=full）
├── methodologies-min.json  # 最小骨架方法论（general_analysis 等，granularity=minimal）
├── evidence-contracts.json # 证据契约
└── tool-index.json         # 企业工具索引（syncToolIndex 回写产物）
```

### 3.2 查询逻辑

```typescript
class MockOrchestrator implements Orchestrator {
  private relations: RelationObject[];
  private methodologies: Methodology[];
  private contracts: EvidenceContract[];

  constructor(dataDir = "data/relos-mock/") {
    this.relations = loadJson(`${dataDir}/relations.json`).relations;
    this.methodologies = [
      ...loadJson(`${dataDir}/methodologies-full.json`).methodologies,
      ...loadJson(`${dataDir}/methodologies-min.json`).methodologies,
    ];
    this.contracts = loadJson(`${dataDir}/evidence-contracts.json`).contracts;
  }

  async getMethodology(topic: string, _ctx: BizContext): Promise<Methodology | null> {
    const m = this.methodologies.find((m) => m.topic === topic);
    if (!m) return null;
    return { ...m, source: "mock" };
  }

  async getCausalChain(symptom: string, ctx: BizContext): Promise<CausalChain | null> {
    // 1. 按 ctx.scenarioId / ctx.line 过滤 properties.appliesScenario/appliesLine
    const applicable = this.relations.filter((r) => {
      if (r.relation_type.indexOf("INDICATES") < 0 && r.relation_type.indexOf("CAUSES") < 0) return false;
      const props = r.properties ?? {};
      const sceneMatch = !props.appliesScenario || props.appliesScenario.includes(ctx.scenarioId);
      const lineMatch = !props.appliesLine || props.appliesLine.includes(ctx.line);
      return sceneMatch && lineMatch;
    });
    if (applicable.length === 0) return null;
    // 2. 组装成 CausalChain 格式（对齐 relos ContextBlock）
    return this.buildCausalChain(applicable, symptom);
  }

  async getEvidenceContract(conclusion: string, _ctx: BizContext): Promise<EvidenceContract | null> {
    const c = this.contracts.find((c) => c.conclusion === conclusion);
    return c ? { ...c, source: "mock" } : null;
  }

  async syncToolIndex(manifest: ToolManifest[]): Promise<void> {
    // mock 模式：写一份 data/relos-mock/tool-index.json（模拟企业回写）
    writeJson("data/relos-mock/tool-index.json", { tools: manifest, syncedAt: new Date().toISOString() });
  }
}
```

### 3.3 与现有代码的衔接

`MockOrchestrator` 的数据**派生自现有 mock**，不是凭空捏造：

| MockOrchestrator 产出 | 现有数据来源 | 迁移动作 |
|---|---|---|
| `getCausalChain` 的 `chains` | `scenarios.ts` 的 `CAUSAL_CHAIN.chains` | 字段映射 + 补 confidence |
| `getCausalChain` 的 `fishbone` | `scenarios.ts` 的 `CAUSAL_CHAIN.fishbone`（`string[]`） | 升级为 `FactorEntry[]`（补 confidence + evidenceRefs） |
| `getMethodology("dmaic")` | `skills/dmaic.ts` 的 `steps` 序列 | 提取 phases + requiredData |
| `getMethodology("oee_diagnose")` | `skills/oee-diagnose.ts` 的 `steps` | 同上 |
| `getEvidenceContract` | 散落在 skill steps 里的隐性校验 | 显式化为契约数据 |

---

## 4. 降级链实现（D6 决策落地）

### 4.1 FallbackChain 设计

```typescript
class FallbackChain implements Orchestrator {
  private layers: Orchestrator[];

  constructor(layers: Orchestrator[]) {
    // 按优先级排序：[CacheLayer, RelosOrchestrator, MockOrchestrator]
    this.layers = layers;
  }

  async getMethodology(topic: string, ctx: BizContext): Promise<Methodology | null> {
    for (const layer of this.layers) {
      const result = await layer.getMethodology(topic, ctx);
      if (result) return result; // 命中即返回
    }
    return null; // 全部未命中 → LLM 自由 ReAct 兜底
  }
  // ... 其他方法同理
}
```

### 4.2 各层实现

```typescript
// boot.ts 里组装
const orchestrator = new FallbackChain([
  new CacheLayer("data/relos-cache/"),      // ① boot 时加载的缓存（最快）
  new RelosOrchestrator("http://relos:8000"), // ② 在线 relos（最优，需网络）
  new MockOrchestrator("data/relos-mock/"),  // ③ mock 规则（兜底）
]);
```

| 层 | 命中条件 | source 标注 | 含义 |
|---|---|---|---|
| `CacheLayer` | 本地有缓存文件 | `cache`（未过期）/ `cache_stale`（过期） | 最快，但可能过时 |
| `RelosOrchestrator` | relos 在线可达 | `relos` | 最优，最新知识 |
| `MockOrchestrator` | 上述都未命中 | `mock` | 本地兜底，知识固定 |

### 4.3 source 字段的消费

`source` 透传到 `ContextBlock`（对齐 relos §4.2），LLM 在 system prompt 里能看到：

```markdown
## 方法论指导（DMAIC）
- 来源：cache_stale（缓存已过期，请审慎参考）
- 置信度：0.75
- 阶段：D → M → A → I → C
...
```

LLM 看到 `cache_stale` 会更倾向自主判断（而非死板遵循规则）；看到 `relos` 会更严格遵循。

### 4.4 缓存更新策略

```typescript
// boot 时
async function bootOrchestrator() {
  const cache = new CacheLayer("data/relos-cache/");
  await cache.loadAll();  // 同步加载缓存（快）

  // 后台异步刷新（不阻塞 boot）
  scheduleBackgroundRefresh(async () => {
    try {
      const relos = new RelosOrchestrator(config.relosUrl);
      const fresh = await relos.getMethodology("dmaic", {});
      if (fresh) await cache.save("dmaic", fresh);
    } catch {
      // 刷新失败不阻断，继续用旧缓存（已经是 cache_stale）
    }
  }, { intervalMinutes: 30 });
}
```

---

## 5. Path Y 编排模式（D5 决策落地）

### 5.1 三种编排路径对比

| 路径 | skill 角色 | LLM 自由度 | 一致性 | 适用 |
|---|---|---|---|---|
| **Path X**（激进） | 完全退化为 hint | 极高（全自由 ReAct） | 低（每次编排可能不同） | 开放探索 |
| **Path Y**（采用） | 骨架 + 适配点 | 中（骨架内自主） | 高（阶段一致，工具灵活） | **本架构主路径** |
| **Path Z**（现状） | 硬编码固定序列 | 低（被 skill 拽着走） | 极高（但僵化） | 兜底/极端场景 |

### 5.2 Path Y 的执行流程

以"DMAIC 分析"为例，对比现状与 Path Y：

**现状（Path Z）**：
```
LLM 调 skill.dmaic → skill 内部跑完 D/M/A/I/C 五个 ctx.call → 返回结果
LLM 只看到最终结果，无法介入中间决策
```

**Path Y**：
```
1. LLM 识别意图是 DMAIC → 调 orchestrator.getMethodology("dmaic")
   → 得到 {phases: [D,M,A,I,C], granularity: "full", source: "relos", confidence: 0.9}

2. LLM 进入 D 阶段（自己决定，但受 methodology 约束）
   D.requiredData = [{semantic:"oee",required:true}, {semantic:"process_capability",required:true}, ...]
   → 对每个 need 调 toolResolver.resolve(need)
   → 得到真实工具，LLM 调用之

3. LLM 想进 M 阶段 → governance 检查 D.blocking=true
   → 调 orchestrator.getEvidenceContract("D_complete")
   → 校验 collectedEvidence 是否满足
   → 满足则放行，不满足则提示 LLM 补数据

4. LLM 自主决定 M 阶段调哪些工具（methodology 只给 requiredData，不给固定工具序列）
   → 可能调 quality.defect_rate + quality.cp_cpk
   → 也可能调 mes.defect_stats（不同企业）

5. 直到 C 阶段完成 → LLM 产出的分析结果是 EvidenceEnvelope
```

**关键差异**：
- methodology 提供"做什么"（阶段 + 语义需求），不提供"怎么做"（具体工具序列）
- LLM 在语义需求范围内自主选工具（通过 ToolResolver 解析）
- governance 在 blocking 点校验证据充分性（通过 EvidenceContract）

### 5.3 skill 在 Path Y 下的角色

skill 不消失，但角色变化：

| 阶段 | skill 角色 |
|---|---|
| Phase 0-2 | 保持现状（硬编码 steps 作为兜底） |
| Phase 3 | skill 仍可调，但主路径走 Orchestrator + LLM |
| Phase 4 | skill 退化为"relos 不可用时的兜底骨架"；dmaic.ts 等保留但不被主流程优先调用 |

---

## 6. relos API 映射（未来 RelosOrchestrator 实现）

`RelosOrchestrator` 把 `Orchestrator` 接口映射到 relos 的 HTTP API（见 relos 开发者指南 §6）：

| Orchestrator 方法 | relos API | 映射逻辑 |
|---|---|---|
| `getMethodology(topic, ctx)` | `POST /v1/relations/subgraph` + 本地组装 | 取 `relation_type` 含 `METHODOLOGY` 的关系，组装成 Methodology |
| `getCausalChain(symptom, ctx)` | `POST /v1/decisions/analyze-alarm` | 直接消费 `evidence_relations` + `recommended_cause` |
| `getEvidenceContract(conclusion, ctx)` | `POST /v1/relations/subgraph`（按 conclusion 节点查） | 取关联关系，组装成契约 |
| `syncToolIndex(manifest)` | `POST /v1/expert-init/batch` | 把 manifest 作为 `mes_structured` 关系写入 |

**ContextBlock 复用**：relos 的 `ContextBlock.content`（Markdown）可直接注入 nexusops 的 system prompt（relos 开发者指南 §4.2 明确支持）。`RelosOrchestrator` 只需做格式适配。

---

## 7. 与 prepare-step 的集成

现有 `prepare-step`（react-harness 的钩子）负责动态工具选择和 prompt 注入。引入 Orchestrator 后：

```typescript
// prepare-step 新增逻辑（伪代码）
async function prepareStep(state: ReActState) {
  // 现有逻辑：detectDominantDomain + tool culling ...

  // 新增：注入 Orchestrator 指导
  if (state.turn === 0) {
    const methodology = await orchestrator.getMethodology(state.inferredTopic, state.bizContext);
    if (methodology) {
      state.systemPrompt += renderMethodologyGuidance(methodology);
      // 形如："当前分析遵循 DMAIC 方法论（置信度 0.9，来源 relos）。阶段：D→M→A→I→C。..."
    }
  }

  // 新增：blocking 点校验
  if (state.intent.includes("进入下一阶段")) {
    const contract = await orchestrator.getEvidenceContract(state.currentPhase + "_complete", state.bizContext);
    if (contract && !verifyEvidence(state.collectedEvidence, contract)) {
      state.systemPrompt += `\n⚠️ 证据不足，无法进入下一阶段。缺失：${missingEvidence(contract, state.collectedEvidence)}`;
    }
  }
}
```

### 7.1 Phase 4 实现差异（实际落地版本）

上述伪代码在 Phase 4 已落地为 `apps/nexusops/server/prepare-step.ts`，与设计版的差异如下：

| 方面 | 设计版（伪代码） | 实现版 | 原因 |
|---|---|---|---|
| topic 识别 | `state.inferredTopic`（隐含外部推断） | `inferMethodologyTopic(intent)` 用正则匹配用户首条消息关键词 | Phase 4 无外部意图推断器，用关键词正则简化；未来可换 LLM 推断 |
| 方法论缓存 | 未提 | `buildMethodologyGuidance` 接受 `cached` 参数，同会话内 topic 不变避免重复查 | 性能优化（对齐 Q3 倾向） |
| blocking 校验 | `getEvidenceContract` 软提示 | Phase 4 暂未启用硬契约校验，仅注入方法论骨架 | 契约校验是 governance 层职责，Phase 4 聚焦 LLM 主导编排，governance 留到后续迭代 |
| 方法论 topic 覆盖 | dmaic / oee 等少数 | 8 个 topic：dmaic / oee_diagnose / downtime_root_cause / waste_audit / energy_analysis / **qs16949_audit** / cost_summary / multi_perspective_rca / general_analysis（兜底） | 实际需求覆盖更广 |

### 7.2 诊断类 vs 评估类方法论的区分（QS16949）

Phase 4 引入 QS16949 内审场景后，发现分析方法论天然分两类，prepare-step 对其做差异化 prompt 注入：

| 类型 | 代表 topic | 方法论结构 | prompt 引导差异 |
|---|---|---|---|
| **诊断类**（Diagnose） | dmaic / oee_diagnose / downtime_root_cause | 围绕"找根因"组织阶段（D-M-A-I-C） | 引导 LLM 聚焦 5Why + 鱼骨图 + 根因验证 |
| **评估类**（Assess） | qs16949_audit | 围绕"符合性判定"组织阶段（scope→evidence→gap_analysis→improve） | 引导 LLM 聚焦条款匹配 + 不符合项判定 + 纠正措施，**不强调根因** |

**实现位置**：`inferMethodologyTopic` 用 `/16949\|内审\|符合性\|审核\|audit/` 正则识别 QS16949 类问题，路由到 `qs16949_audit` 方法论（mock 数据中 phases 为四阶段评估结构）。

**为何重要**：避免评估类问题被错误地套用诊断类方法论（如让 QS16949 审核去"找根因"导致主题漂移）。这一区分也同步传导给质量评估器（见 [03-report-system-design.md](03-report-system-design.md) §10.5）。

---

## 8. 开放问题（Phase 4 后状态）

| # | 问题 | 当前倾向 | 状态 |
|---|---|---|---|
| Q1 | `getMethodology` 的 topic 如何识别？由 LLM 推断还是显式传入？ | 倾向：prepare-step 根据用户首条消息 + 已调工具推断；LLM 也可显式 `orchestrator.get_methodology(topic=...)` 调用 | **已实现**（简化版）：prepare-step 用 `inferMethodologyTopic` 正则匹配关键词；显式工具调用待后续 |
| Q2 | EvidenceContract 校验失败时，是硬阻塞还是软提示？ | 倾向：软提示（保持 LLM 主导），但在报告里标注"证据不充分" | **未启用**：Phase 4 聚焦 LLM 主导编排，governance 契约校验留到后续迭代 |
| Q3 | Orchestrator 的查询结果是否缓存到本次会话的内存？ | 倾向：是（同会话内 topic 不变，避免重复查） | **已实现**：`buildMethodologyGuidance` 的 `cached` 参数做会话级缓存 |

这些问题在 Phase 0 实现时可定，不阻塞设计推进。Phase 4 已落地 Q1/Q3，Q2 随 governance 层后续补齐。
