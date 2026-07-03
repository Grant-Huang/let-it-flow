# RelOS 开发者集成指南（外部团队对接用）

**版本**：v1.0
**日期**：2026 年 7 月
**面向读者**：外部开发团队（MES/ERP 适配、Agent 平台对接、前端/可视化集成、数据团队）
**目标**：用一份文档说清楚「RelOS 是什么、怎么用、接口在哪、形成的关系与规则如何被系统应用」。

> 本文档是外部集成的**入口总览**。字段级权威定义以 `relos/core/models.py` 为准；路径与请求体以运行实例的 OpenAPI（`/docs`）为准；逐端点参数请配合 [`docs/api.md`](api.md) 阅读。

---

## 目录

1. [RelOS 是什么](#1-relos-是什么)
2. [RelOS 不做什么（边界）](#2-relos-不做什么边界)
3. [核心概念：关系即知识](#3-核心概念关系即知识)
4. [关系/规则如何被应用（重点）](#4-关系规则如何被应用重点)
5. [典型集成方式](#5-典型集成方式)
6. [API 总览](#6-api-总览)
7. [数据模型速查](#7-数据模型速查)
8. [端到端调用流程](#8-端到端调用流程)
9. [集成前的 Check List](#9-集成前的-check-list)
10. [常见误区与 FAQ](#10-常见误区与-faq)

---

## 1. RelOS 是什么

RelOS（Relation Operating System）是工业场景下的**关系操作系统**，定位为现有 MES/ERP 之上的一层**可推理认知中间层**。它把工厂中分散在工程师经验、维修记录、传感器、文档里的知识，统一沉淀为**带置信度和来源的关系图谱**，并在此之上提供根因推理、上下文编译、结构化决策与可审计动作包。

一句话定位：

> **把工厂知识从「人头里、文档里、日志里」变成「可计算、可推理、可演化、可审计」的关系数据。**

RelOS 在 Nexus 三层架构中处于 **L2**：

```
L3  AgentNexus     自然语言 / 多 Agent 编排   （大脑皮层）
L2  RelOS   ★      关系记忆 / 推理            （海马体，本系统）
L1  Nexus Ops      设备 / 工单 / MES 执行     （脊髓与四肢）
```

外部团队通常以两种身份与 RelOS 交互：

- **知识贡献方**：把已有的结构化数据、文档、人工经验写入 RelOS（喂关系）。
- **能力消费方**：调用 RelOS 的推理/上下文/决策包，用于自有的 Agent、看板或工作流（用关系）。

---

## 2. RelOS 不做什么（边界）

集成前请先确认 RelOS 的职责边界，避免误用：

| 不在 RelOS 范围内 | 由谁负责 |
|---|---|
| 自然语言对话界面 / `/decide` 式对话审批 | AgentNexus（L3）或上层应用 |
| 多 Agent DAG 编排 | AgentNexus（L3） |
| 直接控制设备 / 采集传感器 | Nexus Ops（L1） |
| 对 MES/WMS/MRO/ERP 的**真实写回** | 外部系统通过 MCP/受控网关执行 |
| 商业级 BI 报表门户 | 上层应用 |

**关键安全约束**：RelOS 的 Action Engine 默认开启 **Shadow Mode**——只记录和输出「建议动作包」，不直接触发任何生产系统写入。一期所有执行必须经人工审核后再由上层/MCP 网关落地。

---

## 3. 核心概念：关系即知识

RelOS 里**所有知识**（无论是工程师口述、Excel 导入、文档抽取还是传感器实时数据）最终都收敛为同一种结构：`RelationObject`。

```text
Source(节点)  ──[relation_type]──▶  Target(节点)
   带置信度 confidence、来源 provenance、知识阶段 knowledge_phase、
   半衰期 half_life_days、状态 status、冲突列表 conflict_with …
```

三个关键设计：

1. **置信度（confidence, 0.0–1.0）**：关系不是「真/假」二值，而是带概率的。系统据此决定能不能自动推理、要不要请人复核。
2. **来源（provenance）**：每条关系都记录它来自工程师、传感器、MES、LLM 抽取还是系统推断。来源决定初始置信度区间、合并权重（alpha）和衰减速度。
3. **知识阶段（knowledge_phase）**：bootstrap（公开知识）→ interview（专家访谈）→ pretrain（企业文档）→ runtime（在线反馈）。阶段越高，可信度治理权重越高。

> 详见 [`docs/data-model.md`](data-model.md) 与 `relos/core/models.py`。

### 为什么这样设计

工厂知识天然**不完美、会过期、有冲突**。RelOS 不追求「一次性建好的干净图谱」，而是：

- **不删除**：过期关系归档（archived），冲突关系标注（conflicted），保留完整历史。
- **不盲信 AI**：LLM 抽取的关系**置信度硬上限 0.85**，且**强制进入 `pending_review`**，不自动激活。
- **越用越准**：每次工程师确认/否定都精确更新置信度（数据飞轮）。

---

## 4. 关系/规则如何被应用（重点）

这是外部团队最关心的问题：**我写进 RelOS 的关系，最终怎么起作用？**

关系/规则的应用链路分四层，从底到顶依次是：**置信度演化 → 子图剪枝 → 推理决策 → 动作审计**。

### 4.1 第一层：置信度演化（关系如何被「记住并强化」）

写进来的关系不是静态存放，而是持续被校准：

- **合并（Merge）**：相同节点对 + 相同 `relation_type` 的新观测到来时，按**加权滑动平均**合并：
  `new_confidence = (1 - alpha) * old + alpha * incoming`
  alpha 由新观测的来源决定（工程师 0.3、传感器 0.5、MES 0.4、LLM 0.2）。见 `relos/core/engine.py: merge_confidence`。
- **衰减（Decay）**：长期未更新的关系按指数衰减：
  `confidence(t) = c0 * 0.5^(elapsed_days / half_life_days)`
  半衰期按关系类型配置（设备告警 90 天、物理组成 365 天、停机记录 7 天）。下限 0.05，不会完全消失。见 `HALF_LIFE_CONFIG`。
- **人工反馈（Feedback）**：工程师确认 → `confidence + 0.15` 并转 `active`；否定 → `confidence - 0.30`，低于 0.2 则归档。这是**数据飞轮的核心触发点**。
- **冲突管理**：同节点对同类型关系若置信度差异 > 0.5，标记为 `conflicted`，不删除，等待人工裁决。

> 对接含义：**你的系统每提交一次反馈，RelOS 的下一次推荐就会更准。** 反馈请走 `POST /v1/relations/{id}/feedback`。

### 4.2 第二层：子图剪枝（关系如何被「选出来」给推理用）

当一次告警/事件到来，RelOS 不会把整张图丢给推理引擎，而是经 Context Engine 的**六层剪枝**挑出最相关的子集（见 `relos/context/compiler.py`）：

1. 过滤 `archived` 状态
2. 过滤低于 `min_confidence` 的关系
3. 优先保留与中心节点**直接关联**的关系
4. 按 confidence 降序
5. 相同节点对去重，只保留最高置信度
6. 超出 Token 预算（默认 1500）则截断

剪枝后的子图会被编译成一段**结构化 Markdown**（`ContextBlock`），形如：

```markdown
## 工厂关系上下文（RelOS）
**分析对象节点**: `device-M1`
**当前查询**: 告警码: VIB-001 | 主轴振动超限
### 关系列表
| 关系类型 | 起始节点 | 目标节点 | 置信度 | 来源 |
| ALARM__INDICATES__COMPONENT_FAILURE | alarm-VIB-001 | component-bearing-M1 | 0.70 ████░ | manual_engineer |
```

> 对接含义：**`ContextBlock.content` 可以直接注入你上层 LLM/Agent 的 system prompt**，无需自己实现图检索。`estimated_tokens` 仅供参考，非计费值。

### 4.3 第三层：推理决策（关系如何变成「结论」）

RelOS 的 Decision Engine 采用**三路分级**，按置信度自动选择最省成本的路径（见 `relos/decision/workflow.py`）：

| 子图平均置信度 | 路径 | 行为 | 成本 |
|---|---|---|---|
| ≥ 0.75 | **规则引擎** | 直接用高置信度 `INDICATES` 关系推断根因 | 零 LLM Token |
| 0.5 – 0.75 | **LLM 融合** | 把 ContextBlock 喂给 Claude，输出结构化根因 | 调用 LLM |
| < 0.5 | **Human-in-the-Loop** | 进入待审队列，请工程师裁决 | 人工 |

此外有**六条强制 HITL 规则**（任一命中即升级人工）：

1. 子图平均置信度 < 0.5
2. critical 告警且无高置信度（≥0.75）历史关系
3. 冲突关系数量 > 2
4. 图中无数据（新设备）
5. 规则引擎无匹配 + LLM confidence < 0.4
6. 工程师手动 `force_hitl=true`

输出（`POST /v1/decisions/analyze-alarm`）是**可解释**的：除根因和置信度外，还带 `evidence_relations`（证据关系）、`phase_contributions`（按知识阶段的贡献占比）和 `confidence_trace_id`（可审计追踪 ID）。

> 对接含义：**你拿到的不是黑盒答案，而是「结论 + 证据 + 追踪号」**。低置信度结果会显式告诉你「需要人工」，不要把 `requires_human_review=true` 当作失败，它表示「需要升级到人工确认」。

### 4.4 第四层：动作与审计（关系如何变成「可执行动作」）

推理结论可以转化为**可审计的动作**，但默认走 Shadow Mode（见 `relos/action/engine.py`）：

- **八状态机**：`PENDING → PRE_FLIGHT_CHECK → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED → ROLLED_BACK`
- **Pre-flight Check 五步验证**：设备 ID 合法、操作描述合理、告警存在、操作类型在白名单（MVP 仅允许检查类）、24h 内无重复。
- **Shadow Mode**：EXECUTING 阶段**只记录日志，不真实执行**。

对**复合扰动场景**（插单 + 设备异常 + 物料短缺等多事件叠加），RelOS 输出结构化 `DecisionPackage` + `ActionBundle`：

- `DecisionPackage`：含候选方案、推荐方案、证据关系、是否需人工审核
- `ActionBundle`：与 `decision_id` 绑定的 Shadow 动作包，每条动作带 `payload_preview`
- 审核通过后（`POST /v1/decisions/{decision_id}/review`），上层系统再把 `payload_preview` 转成对 MES/MRO 的真实 MCP 调用

> 对接含义：**RelOS 永远不直接写你的生产系统。** 你拿到的是「已经过 Pre-flight 校验、可审计、待你执行」的动作包，由你决定如何落地。

### 4.5 一张图看懂「关系的一生」

```text
         (写入)                                   (应用)
工程师/Excel/文档/传感器 ──▶ RelationObject ──▶ 六层剪枝 ──▶ ContextBlock
   │                            │                                   │
   │                       合并/衰减/反馈                          │
   │                       (置信度演化)                            │
   │                            │                                   ▼
   │                       pending_review ──▶ active ──▶ 三路决策 (规则/LLM/HITL)
   │                                                              │
   │                                                              ▼
   │                                                    DecisionPackage + ActionBundle
   │                                                              │
   │                                              (Shadow, 只记录不执行)
   │                                                              │
   └──────────── 人工审核 ◀──────────────────────────────────────┘
                          │
                          ▼
                  上层/MCP 网关执行真实写回
```

---

## 5. 典型集成方式

按你的角色选择集成模式：

### 5.1 作为「知识贡献方」（写入关系）

适用：已有 MES 历史告警、CMMS 工单、FMEA 表、专家文档，想沉淀进 RelOS。

- **结构化数据**：用 `POST /v1/expert-init/batch` 或 `POST /v1/expert-init/upload-excel`（支持中英文列名）。来源标记为 `manual_engineer`/`mes_structured`，直接 `active`。
- **企业文档（xlsx/docx）**：用 `POST /v1/documents/upload` 走「AI 抽取 → 人工标注 → 提交图谱」流水线。提交后 `provenance` 自动判定为 `structured_document` 或 `expert_document`，状态为 `pending_review`。
- **公开知识/文本**：用 `POST /v1/knowledge/public/extract` 只抽取**候选草稿**，默认不入库，审核后再 `POST /v1/relations` 写入。
- **行业模板初始化**：`POST /v1/ontology/templates/{industry}/import`（支持 `dry_run` 预览），新关系默认 `pending_review`，已存在的同节点对会跳过。

### 5.2 作为「能力消费方」（调用推理/决策）

适用：自建 Agent、看板、报警处置流程。

- **单告警根因**：`POST /v1/decisions/analyze-alarm`（或 SSE 流式版 `POST /v1/decisions/analyze-alarm/stream`）。
- **复合扰动决策**：`POST /v1/scenarios/composite-disturbance/analyze`，拿 `DecisionPackage`。
- **只要上下文**：`POST /v1/relations/subgraph` 取子图，或直接消费 `ContextBlock.content` 注入你自己的 LLM。
- **聚合分析**：场景 7–12 的 `/v1/scenarios/*` 端点（产线效率、跨部门协同、风险雷达、战略模拟等）。

### 5.3 作为「Agent 平台」（L3 对接）

适用：AgentNexus 或自研多 Agent 系统。完整契约见 [`docs/agentnexus_relos_contract.md`](agentnexus_relos_contract.md)，核心三件套：

- `ContextBlock`：Markdown 上下文
- `DecisionPackage`：结构化决策包
- `ActionBundle`：Shadow 动作包（`payload_preview` 供你转 MCP 调用）

调用顺序：`analyze` → 读 `DecisionPackage` → 必要时 `pending-review` → `review` → `actions` → 你的 MCP 网关。

### 5.4 作为「执行层」（L1 对接）

适用：Nexus Ops 或 MES/MRO 适配器。

- 不要期望 RelOS 主动调用你。RelOS 只输出 `ActionBundle`。
- 你的系统应订阅/拉取审核通过的 `ActionBundle`，按 `payload_preview` 执行真实写回，再把结果回写（`executed` / `rolled_back`）。

---

## 6. API 总览

**Base URL**：`http://<host>:8000/v1`
**格式**：JSON
**认证**：默认 `JWT_ENABLED=false`（开发）；生产置 `true` 后除公开路径外需 `Authorization: Bearer <token>`。
**权威 Schema**：运行实例的 `/docs`（OpenAPI）。

按职能分组（详细参数见 [`docs/api.md`](api.md)）：

| 分组 | 代表端点 | 用途 |
|---|---|---|
| 健康 | `GET /health` | 服务与 Neo4j 连通性 |
| 关系写入 | `POST /relations` | 创建/合并关系（统一收敛点） |
| 关系查询 | `GET /relations/{id}`、`POST /relations/subgraph` | 单条查询、子图提取 |
| 人工反馈 | `POST /relations/{id}/feedback` | **数据飞轮核心**：确认/否定 |
| 待审队列 | `GET /relations/pending-review` | 关系级 HITL |
| 单告警决策 | `POST /decisions/analyze-alarm`（+ `/stream`） | 根因推荐 |
| 动作执行 | `POST /decisions/execute-action`、`GET /decisions/action/{id}` | Shadow 动作记录 |
| 决策级 HITL | `GET /decisions/pending-review`、`POST /decisions/{id}/review`、`GET /decisions/{id}/actions` | 复合场景审核 |
| 专家录入 | `POST /expert-init`、`/batch`、`/upload-excel` | 结构化知识沉淀 |
| 文档摄取 | `POST /documents/upload` + annotate/clarify/commit | 文档 → 图谱流水线 |
| 公开知识 | `POST /knowledge/public/extract` | 文本抽取草稿（默认不入库） |
| 访谈微卡片 | `POST /interview/sessions` + next/submit | 结构化专家调研 |
| 场景分析 | `GET/POST /scenarios/*` | 场景 7–12、复合扰动 |
| 本体模板 | `GET/POST /ontology/templates/*` | 行业模板列出/导入 |
| 图谱统计 | `GET /metrics` | 健康度与规模 |
| 配置/遥测 | `GET /config/*`、`POST/GET /telemetry/*` | 演示配置、埋点 |

统一返回结构（部分 `GET` 与 OpenAPI 原生返回除外）：

```json
{ "status": "success|error", "data": {...}, "message": "" }
```

---

## 7. 数据模型速查

### 7.1 RelationObject（最重要的 Schema）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | str | UUID |
| `relation_type` | str | `DOMAIN__VERB__DOMAIN`，如 `DEVICE__TRIGGERS__ALARM` |
| `source_node_id` / `source_node_type` | str | 起始节点 |
| `target_node_id` / `target_node_type` | str | 终止节点 |
| `confidence` | float 0–1 | 置信度 |
| `knowledge_phase` | enum | bootstrap/interview/pretrain/runtime |
| `phase_weight` | float 0–1 | 阶段权重（未传则按 phase 回填） |
| `provenance` | enum | manual_engineer/sensor_realtime/mes_structured/llm_extracted/inference/structured_document/expert_document |
| `provenance_detail` / `extracted_by` | str | 来源详情、抽取者 |
| `half_life_days` | int | 半衰期（按 relation_type 配置） |
| `status` | enum | pending_review/active/conflicted/archived |
| `conflict_with` | list[str] | 冲突关系 ID |
| `properties` | dict | 业务扩展 |

### 7.2 来源 → 置信度/合并权重/阶段映射

| provenance | 初始置信度 | 合并 alpha | 默认 knowledge_phase |
|---|---|---|---|
| manual_engineer | 0.90–1.00 | 0.30 | interview |
| sensor_realtime | 0.80–0.95 | 0.50 | runtime |
| mes_structured | 0.75–0.90 | 0.40 | pretrain |
| llm_extracted | 0.50–**0.85（硬上限）** | 0.20 | pretrain |
| structured_document | 0.65–0.85 | 0.35 | pretrain |
| expert_document | 0.50–0.85 | 0.25 | pretrain |
| inference | 0.40–0.75 | 0.15 | runtime |

### 7.3 阶段权重默认值

| knowledge_phase | phase_weight |
|---|---|
| bootstrap | 0.35 |
| interview | 0.90 |
| pretrain | 0.70 |
| runtime | 1.00 |

### 7.4 复合场景三件套

- `CompositeDisturbanceEvent`（输入）：多子事件 + 时间窗 + 目标
- `DecisionPackage`（输出）：候选方案 + 推荐方案 + 证据 + 审核状态
- `ActionBundle`（Shadow 动作）：与 `decision_id` 绑定，含 `payload_preview`

完整字段见 [`docs/agentnexus_relos_contract.md`](agentnexus_relos_contract.md) 与 `relos/core/models.py`。

---

## 8. 端到端调用流程

### 8.1 最小闭环（写入 → 推理 → 反馈 → 强化）

```bash
# 0) 启动后注入种子数据（可选）
python scripts/seed_neo4j.py

# 1) 写入一条专家关系（直接 active）
curl -X POST http://localhost:8000/v1/expert-init \
  -H "Content-Type: application/json" \
  -d '{
    "source_node_id":"device-M1","source_node_type":"Device",
    "target_node_id":"component-bearing-M1","target_node_type":"Component",
    "relation_type":"DEVICE__INDICATES__COMPONENT_FAILURE",
    "confidence":0.85,"engineer_id":"zhang",
    "provenance_detail":"张工 20 年经验"
  }'

# 2) 触发告警根因分析（会用到上面的关系）
curl -X POST http://localhost:8000/v1/decisions/analyze-alarm \
  -H "Content-Type: application/json" \
  -d '{
    "alarm_id":"ALM-001","device_id":"device-M1",
    "alarm_code":"VIB-001","alarm_description":"主轴振动超限"
  }'
# → 返回 recommended_cause / confidence / evidence_relations / confidence_trace_id

# 3) 工程师反馈（数据飞轮，下次更准）
curl -X POST http://localhost:8000/v1/relations/<relation_id>/feedback \
  -H "Content-Type: application/json" \
  -d '{"engineer_id":"zhang","confirmed":true}'
```

### 8.2 文档摄取闭环

```bash
# 上传 → 轮询到 pending_review → 标注 → 提交图谱
curl -X POST http://localhost:8000/v1/documents/upload -F "file=@cmms.xlsx"
# 轮询 GET /v1/documents/{id} 直到 status=pending_review
curl -X POST http://localhost:8000/v1/documents/{id}/annotate/{rel_id} \
  -d '{"action":"approve"}'
curl -X POST http://localhost:8000/v1/documents/{id}/commit
```

### 8.3 复合扰动决策闭环

```bash
# 1) 分析
curl -X POST http://localhost:8000/v1/scenarios/composite-disturbance/analyze \
  -d '{ "incident_id":"inc-1", "events":[...], "goal":"保交付" }'
# → DecisionPackage (requires_human_review=true)

# 2) 审核
curl -X POST http://localhost:8000/v1/decisions/decision-inc-1/review \
  -d '{ "reviewed_by":"li", "selected_plan_id":"plan-1", "approve":true }'

# 3) 取动作包（上层转 MCP 执行）
curl http://localhost:8000/v1/decisions/decision-inc-1/actions
```

---

## 9. 集成前的 Check List

- [ ] 已读 [§2 边界](#2-relos-不做什么边界)，确认要做的事在 RelOS 范围内。
- [ ] 已起好开发环境（Neo4j + Redis + API），`GET /health` 返回 `ok`。见 [`docs/quickstart.md`](quickstart.md)。
- [ ] 已决定 `provenance` 策略：你的数据来自哪一类？这决定置信度区间和合并行为。
- [ ] 已规划**反馈闭环**：谁负责确认/否定？没有反馈，图谱不会自我进化。
- [ ] 已确认 **Shadow Mode** 语义：一期所有动作不真实执行，需上层落地。
- [ ] LLM 相关端点：已配置 `ANTHROPIC_API_KEY`，或接受 Mock 模式。
- [ ] 生产环境：`JWT_ENABLED=true`，密钥不走代码；`SHADOW_MODE` 按需关闭（Sprint 3 后可用）。

---

## 10. 常见误区与 FAQ

**Q1：我把 Excel 导进去，为什么推荐还是不准？**
A：检查三点：(1) 关系是否 `active`（LLM 抽取的是 `pending_review`）；(2) `confidence` 是否够高（低于 0.5 走 HITL）；(3) 有没有反馈闭环在持续校准。

**Q2：`requires_human_review=true` 是不是报错？**
A：不是。它表示「系统主动升级到人工确认」，是预期行为。请展示 `review_reason` 给用户，不要吞掉。

**Q3：RelOS 会直接改我的 MES 排产吗？**
A：不会。一期只输出 `ActionBundle`（Shadow），由你的上层/MCP 网关执行真实写回。

**Q4：`ContextBlock.content` 能直接给前端渲染吗？**
A：不推荐。它是面向 LLM 的 Markdown，不是 UI 数据。前端应消费结构化字段（如 `evidence_relations`、`phase_contributions`）。

**Q5：LLM 抽取的关系置信度为什么最高才 0.85？**
A：设计约束。`provenance=llm_extracted` 时 `confidence` 硬夹紧到 0.85，且强制 `pending_review`。要提升需人工确认（每次 +0.15）。

**Q6：关系会消失吗？**
A：不会。最差也会被 `archived`（保留历史）或 `conflicted`（标注冲突）。衰减有 0.05 下限。

**Q7：我想接自家的行业本体？**
A：用 `/v1/ontology/templates/*` 管理模板；或直接按 `RelationObject` schema 用 `POST /v1/relations` 写入，`relation_type` 遵循 `DOMAIN__VERB__DOMAIN` 命名。

---

## 相关文档索引

| 主题 | 文档 |
|---|---|
| 快速部署与首次运行 | [`docs/quickstart.md`](quickstart.md) |
| 内部产品需求（用户故事/KPI/版本） | [`docs/PRD.md`](PRD.md) |
| 系统架构与模块设计 | [`docs/architecture.md`](architecture.md) |
| 数据模型字段说明 | [`docs/data-model.md`](data-model.md) |
| 逐端点 API 参数 | [`docs/api.md`](api.md) |
| L3 Agent 对接契约 | [`docs/agentnexus_relos_contract.md`](agentnexus_relos_contract.md) |
| 演示场景说明 | [`docs/demo-scenarios.md`](demo-scenarios.md) |
| 用户操作手册 | [`docs/user-manual.md`](user-manual.md) |

> 字段级权威定义：`relos/core/models.py`。路径与请求体权威：运行实例 OpenAPI `/docs`。
