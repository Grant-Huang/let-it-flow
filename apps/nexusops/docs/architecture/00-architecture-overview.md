# NexusOps 架构重构总览：LLM 主导分析 + relos 编排知识 + 组件化报表

**版本**：v1.0（设计草案）
**日期**：2026 年 7 月
**状态**：待评审 → 进入 Phase 0 实施
**关联文档**：`docs/relos/developer-integration-guide.md`、`docs/mock-data-audit.md`

---

## 1. 背景与动机

### 1.1 触发问题：主题漂移与硬编码耦合

在一次 6 Sigma（DMAIC）分析中，系统前期正确执行了 DMAIC 流程，但最终产出的诊断报告却退化成了 OEE 根因分析报告。排查发现三个根因：

1. **`skill.report_html` 写死了 OEE 模板**：无论前置分析是什么主题，最终都渲染含根因树的 OEE 报告。
2. **系统提示因果链纪律过强**：`NEXUS_SYSTEM_PROMPT` 的 5b 步无条件要求"调 `skill.report_html` 生成报告"，且因果链纪律引导 LLM 始终走根因路径。
3. **方法论知识硬编码在 skill 的 steps 里**：`dmaic.ts`、`oee-diagnose.ts` 等把"D-M-A-I-C 五阶段""OEE 诊断四步"写死成 `ctx.call` 序列，LLM 无法根据实际情况调整编排。

这三个问题指向同一个架构缺陷：**编排知识（做什么、按什么顺序）与执行机制（怎么调工具）耦合在 skill 代码里**。

### 1.2 更深层的需求：面向企业的可移植性

不同企业的制造系统环境差异巨大：

- **命名异构**：同样是查过程能力，A 企业叫 `quality.cp_cpk`，B 企业叫 `mes.capability`，C 企业根本没有这个工具。
- **数据残缺**：有的企业有完整的 IoT 振动监测，有的只有手工巡检记录。
- **格式差异**：同样是缺陷率，MES 返回 `{defectRate: 0.058}`，QMS 返回 `{dppm: 58000}`。

现有架构把"语义需求"（要过程能力数据）和"工具名"（`quality.cp_cpk`）直接绑定，导致换企业就要改 skill 代码。

### 1.3 目标架构：三层解耦

本次重构把分析系统拆成三层，每层职责单一：

```
┌─────────────────────────────────────────────────────────┐
│  分析编排层（LLM 主导）                                   │
│  - 根据 Orchestrator 给的方法论 + 实际证据，动态决定下一步 │
│  - 不再被 skill 的硬编码 steps 拽着走                     │
└───────────────┬─────────────────────────────────────────┘
                │ 语义需求（process_capability）
                ▼
┌─────────────────────────────────────────────────────────┐
│  知识/适配层                                              │
│  - Orchestrator：提供方法论骨架 + 因果知识（relos 抽象）  │
│  - ToolResolver：语义需求 → 当前企业的真实工具（适配层）  │
└───────────────┬─────────────────────────────────────────┘
                │ 真实工具调用（quality.cp_cpk）
                ▼
┌─────────────────────────────────────────────────────────┐
│  工具执行层（现有 ToolRegistry + FlowConnector）           │
│  - 不感知上层是 LLM 还是 skill 在调                       │
│  - 返回 EvidenceEnvelope                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 锁定的架构决策（已与用户确认）

以下决策在前期讨论中已明确确认，是后续所有设计的约束前提：

| # | 维度 | 决策 | 理由 |
|---|---|---|---|
| D1 | relos 形态 | 关系图谱 + 规则带置信度 | 对齐 relos 实际产品形态（见 relos 开发者指南 §3） |
| D2 | relos 介入时机 | boot 时加载缓存 + 后台定时更新 | 启动快（缓存命中），知识不过时（后台刷新） |
| D3 | relos 与企业工具关系 | relos 通用（只懂业务语义），适配层做工具映射 | 松耦合：relos 不绑定具体企业工具集 |
| D4 | 企业工具索引回写 | 企业实施后可把工具集索引回写 relos（双向） | relos 能给出更精准的工具建议，但不强制 |
| D5 | 分析主导权 | LLM 主导执行，relos 规则按执行度指导 + 约束 | 平衡灵活性与一致性 |
| D6 | relos 缓存失效策略 | 用过期缓存（标注 source）；无缓存则 LLM 自由 ReAct 兜底 | 保证可用性，降级不崩溃 |
| D7 | 报表编排方案 | C 方案：LLM 输出组件序列 JSON，渲染器消费 | 安全（LLM 不碰 HTML）+ 一致（组件库统一风格） |
| D8 | 报表固化形态 | JSON 配置（非 TS 函数），存 SkillRegistry | 无需发版，运行时加载 |
| D9 | 报表固化入口 | 人工主动固化，入口在右栏 artifacts 栏 | 用户可控，避免噪音 |
| D10 | 工具语义标注位置 | 工具侧（工具自带语义索引），实施时初始化 | 声明即文档，工具自带语义 |
| D11 | 方法论 mock 粒度 | C 混合：成熟方法论（DMAIC/OEE）完整结构化；开放场景（general_analysis）最小骨架 | 成熟方法论保证一致性，开放场景保留灵活性 |

---

## 3. 在 Nexus 三层架构中的定位

延续 relos 文档定义的 Nexus 三层模型，本次重构主要影响 **L3 AgentNexus** 和 **L2 知识层**：

```
L3  AgentNexus（本次重构重点）
    ├── 分析编排（react-harness + prepare-step）     ← 引入 Orchestrator 指导
    ├── 工具适配（tool-adapter + ToolResolver 新增）  ← 引入语义→工具映射
    ├── 技能系统（skill-bridge）                     ← 退化为兜底骨架
    └── 报表生成（report-html + 组件库 新增）         ← 组件化重构

L2  知识层
    ├── 现状：mock 在 scenarios.ts（CAUSAL_CHAIN）、evidence-map.ts
    ├── 目标：Orchestrator 抽象（MockOrchestrator → RelosOrchestrator）
    └── relos（外部系统，通过 HTTP API 对接）

L1  Nexus Ops（工具执行层，基本不动）
    ├── ToolRegistry + FlowConnector（已有 evidenceMeta 字段）
    └── 各域工具（oee/equipment/quality/process/...）
```

**关键边界**：relos（L2 外部）不直接调 nexusops（L3）的工具，也不感知 ToolRegistry。它只产出业务语义层面的编排知识。适配由 nexusops 内部的 ToolResolver 完成。

---

## 4. 核心设计原则

贯穿所有文档的五条原则：

### P1. 松耦合：业务语义与工具实现分离

编排知识（来自 relos/Orchestrator）只描述"需要什么数据"（如 `process_capability`），不描述"调哪个工具"（如 `quality.cp_cpk`）。工具名由 ToolResolver 在运行时解析。这样 relos 的知识图谱可以跨企业复用。

**反模式**：在 relos 规则里写 `call quality.cp_cpk`——一旦企业没有这个工具，规则失效。

### P2. 渐进式降级：每一层都有兜底

```
relos 在线（最优）  →  relos 缓存（次优）  →  mock 规则（兜底）  →  手写 skill（最后防线）  →  LLM 自由 ReAct（极端兜底）
```

任何一层缺失，系统仍能工作，只是质量下降。`source` 字段（`relos` / `cache` / `cache_stale` / `mock` / `fallback`）透传到 LLM，让它知道当前知识的可信度。

### P3. LLM 主导，规则约束（Path Y）

skill 不再是"被 LLM 调用的、内部跑完固定步骤的黑盒"。而是：
- Orchestrator 提供**方法论骨架**（D-M-A-I-C 五阶段 + 每阶段语义需求）
- LLM 在骨架内**自主决定**调哪些工具、何时进入下一阶段
- 只有在"硬约束点"（如证据不足不能进 Analyze）才由 governance 强制阻塞

详见 [01-orchestrator-design.md §5 Path Y](01-orchestrator-design.md)。

### P4. 报表：LLM 编排组件，不碰 HTML

报表生成遵循"LLM 输出组件序列 JSON，渲染器消费"原则：
- LLM 只决定"用哪些组件、传什么数据"
- 组件库（`ReportComponents`）是受控的渲染函数集合，输出稳定 HTML
- 固化后的报表模板是 JSON 配置，渲染时 0 LLM 调用

这保证安全性（防 XSS）和 UI 一致性。详见 [03-report-system-design.md](03-report-system-design.md)。

### P5. 数据驱动：硬编码知识迁移为可配置规则

现有的硬编码"知识"（`CAUSAL_CHAIN`、各 skill 的 steps 序列、`evidence-map` 的域标签）逐步迁移为结构化数据（JSON 规则）。迁移后：
- 知识可被 Orchestrator 统一管理（而非散落在代码里）
- 知识可被 relos 替换（数据源从本地 JSON → HTTP）
- 知识可被测试（规则有 schema，可校验完整性）

---

## 5. 阶段化路线图（摘要）

详细执行计划见 [05-refactor-roadmap.md](05-refactor-roadmap.md)。这里给出概览：

| 阶段 | 内容 | relos 依赖 | 产出 |
|---|---|---|---|
| **Phase 0** | 抽象接口 + MockOrchestrator | 无 | `Orchestrator`/`ToolResolver`/`ReportComponents` 接口定义；现有硬编码逻辑封装到 Mock 实现 |
| **Phase 1** | 报表组件化 | 无 | 抽取 `ReportComponents` 组件库；重构 OEE/DMAIC 模板用组件；LLM 编排协议 |
| **Phase 2** | 报表固化闭环 | 无 | 右栏"固化"按钮；SkillRegistry 加 `reportTemplates` 表；JSON 模板存取 |
| **Phase 3** | 接入 relos | relos 可用 | `RelosOrchestrator` 实现；boot 缓存加载 + 后台刷新；`syncToolIndex` 回写 |
| **Phase 4** | skill 退化 + 语义标注 | relos 稳定 | dmaic.ts 等改为兜底；工具加 `semanticTags`；主路径走 relos+LLM |

**关键**：Phase 0-2 完全不依赖 relos，现在就能做。做完后报表体系已是 C 方案形态，Orchestrator 抽象已就位。Phase 3-4 等 relos 就绪。

---

## 6. 文档索引

| 文档 | 主题 | 关键内容 |
|---|---|---|
| **00-architecture-overview.md**（本文档） | 总体架构 | 背景、决策汇总、设计原则、路线图 |
| [01-orchestrator-design.md](01-orchestrator-design.md) | 编排器设计 | `Orchestrator` 接口、`Methodology`/`EvidenceContract` 数据结构、`MockOrchestrator`、降级链、relos API 映射、Path Y 编排模式 |
| [02-tool-resolver-design.md](02-tool-resolver-design.md) | 工具解析层 | `ToolResolver` 接口、语义标注（`semanticTags`）、三档解析策略、企业工具索引回写、`fieldMap` 异构格式处理 |
| [03-report-system-design.md](03-report-system-design.md) | 报表系统 | `ReportComponents` 组件库、`ComponentLayout` JSON 协议、渲染器、固化闭环、`postMessage` 安全协议 |
| [04-mock-rules-spec.md](04-mock-rules-spec.md) | Mock 规则规范 | `RelationObject` schema、9 场景矩阵（3 场景 × 3 产线）、C 混合粒度（完整结构化 + 最小骨架）、置信度规范、从现有 mock 迁移映射 |
| [05-refactor-roadmap.md](05-refactor-roadmap.md) | 重构路线图 | Phase 0-4 逐步改造清单、受影响文件、测试策略、风险与回滚、里程碑定义 |

---

## 7. 术语表

| 术语 | 定义 |
|---|---|
| **Orchestrator** | 编排知识源的抽象接口。relos 是它的一个实现，MockOrchestrator 是另一个。提供方法论骨架、因果知识、证据契约。 |
| **ToolResolver** | 语义需求（如 `process_capability`）→ 真实工具（如 `quality.cp_cpk`）的映射层。 |
| **Methodology** | 方法论骨架。描述某分析主题（如 DMAIC）的阶段序列 + 每阶段语义需求。 |
| **SemanticNeed** | 语义需求。业务级别的数据需求描述，不含工具名。如 `oee`、`process_capability`、`causal_chain`。 |
| **EvidenceContract** | 证据契约。描述"得出某结论需要哪些证据 + 最低置信度"。用于 governance 校验。 |
| **ReportComponents** | 报表组件库。受控的渲染函数集合，每个函数输出稳定 HTML 片段。 |
| **ComponentLayout** | LLM 输出的组件序列 JSON。描述"用哪些组件、传什么 data"。渲染器消费它生成最终 HTML。 |
| **RelationObject** | relos 的核心数据结构。带 confidence/provenance/knowledge_phase 的关系。详见 relos 开发者指南 §7.1。 |
| **ContextBlock** | relos 产出的 Markdown 上下文块。可直接注入 LLM 的 system prompt。详见 relos 开发者指南 §4.2。 |
| **Path Y** | 本架构采用的编排模式：skill 作为"骨架 + 适配点"，LLM 在骨架内自主决策。对比 Path X（skill 完全退化为方法论 hint，LLM 全自由）和 Path Z（skill 硬编码固定序列）。 |
| **source 字段** | 标注知识来源的字段。取值：`relos` / `cache` / `cache_stale` / `mock` / `fallback`。透传给 LLM 以调整信任度。 |
