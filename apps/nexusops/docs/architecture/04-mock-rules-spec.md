# 04 - Mock 规则数据规范

**职责**：定义 MockOrchestrator 的数据格式与内容，基于现有 `scenarios.ts` 的 `CAUSAL_CHAIN` 等硬编码数据，生成覆盖 9 个场景（3 场景 × 3 产线）的可用规则集。

**目标**：mock 规则的**输出格式严格对齐 relos 的 `RelationObject` schema**，让未来切到真实 relos 时是"换数据源"而非"换结构"。

---

## 1. 数据存储结构

```
data/relos-mock/
├── relations.json            # 因果知识（RelationObject 列表）
├── methodologies-full.json   # 完整结构化方法论（DMAIC/OEE 等，granularity=full）
├── methodologies-min.json    # 最小骨架方法论（general_analysis 等，granularity=minimal）
├── evidence-contracts.json   # 证据契约（governance 校验用）
└── tool-index.json           # 企业工具索引（syncToolIndex 回写产物，自动生成）
```

---

## 2. RelationObject Schema（对齐 relos）

### 2.1 字段定义（精简版，对齐 relos 开发者指南 §7.1）

```jsonc
{
  "id": "rel-001",                              // UUID
  "relation_type": "DOMAIN__VERB__DOMAIN",      // relos 命名规范
  "source_node_id": "device-注塑机-L01",
  "source_node_type": "Device",
  "target_node_id": "component-主轴轴承-L01",
  "target_node_type": "Component",
  "confidence": 0.85,                           // 0-1
  "knowledge_phase": "interview",               // bootstrap/interview/pretrain/runtime
  "provenance": "manual_engineer",              // 来源（决定置信度区间）
  "half_life_days": 90,                         // 半衰期
  "status": "active",                           // pending_review/active/conflicted/archived
  "properties": {                               // 业务扩展（nexusops mock 特有）
    "appliesScenario": ["anomaly", "crisis"],   // 适用场景过滤
    "appliesLine": ["L01"],                     // 适用产线过滤
    "symptom": "尺寸超差率 5.8%",               // 触发症状
    "evidenceRefs": [                           // 证据引用（指向 scenarios.ts 字段）
      "EQUIPMENT.L01.healthScore",
      "PROCESS.L01.parameters.温度"
    ],
    "causalLayers": [                           // 5Why 逐层链
      "现象：尺寸超差率 5.8%",
      "为何尺寸超差？主轴径向跳动 0.03mm 超规",
      "为何主轴跳动超规？主轴前轴承磨损",
      "为何轴承磨损加速？自动润滑系统供油不足",
      "根本原因：自动润滑泵滤网堵塞"
    ],
    "rootCause": "自动润滑泵滤网堵塞（设备保养类）"
  }
}
```

### 2.2 relation_type 命名规范

遵循 relos 的 `DOMAIN__VERB__DOMAIN`：

| relation_type | 含义 | 用途 |
|---|---|---|
| `DEVICE__INDICATES__COMPONENT_FAILURE` | 设备指示部件失效 | 因果链（设备→部件） |
| `PARAMETER__CAUSES__DEFECT` | 参数异常致缺陷 | 因果链（工艺→质量） |
| `ENVIRONMENT__AFFECTS__PROCESS` | 环境影响工艺 | 鱼骨图（环→法） |
| `METHODOLOGY__HAS_PHASE__ANALYSIS_STEP` | 方法论包含阶段 | 方法论骨架 |
| `CONCLUSION__REQUIRES__EVIDENCE` | 结论需要证据 | 证据契约 |
| `SEMANTIC__IMPLEMENTED_BY__TOOL` | 语义由工具实现 | 工具索引 |

### 2.3 provenance → 置信度映射（对齐 relos §7.2）

| provenance | 初始置信度 | mock 场景的语义 |
|---|---|---|
| `manual_engineer` | 0.90–1.00 | 工程师经验（CAUSAL_CHAIN 的人工根因） |
| `mes_structured` | 0.75–0.90 | MES 历史数据（场景数据的统计规律） |
| `llm_extracted` | 0.50–0.85（硬上限） | LLM 推理（skill 生成的推断） |
| `inference` | 0.40–0.75 | 系统推断（阈值规则） |

---

## 3. 因果规则矩阵（替代 CAUSAL_CHAIN）

### 3.1 9 场景分布

按 `3 场景 × 3 产线`，但**正常场景无因果链**（合理：无问题则无根因），实际需要因果规则的组合：

| 场景 | L01 | L02 | L03 |
|---|---|---|---|
| normal | 空（无问题） | 空 | 空 |
| anomaly | ✅ 主轴轴承磨损链 | ✅ 温控 PID 漂移链 | 空（L03 工况正常） |
| crisis | ✅ 轴承断裂链 + 能耗飙升链（双链强关联） | ✅ 缺料停机链 | 空（L03 工况正常） |

**现有 `CAUSAL_CHAIN` 已覆盖全部需要的场景**（见 `scenarios.ts` 1281-1400 行）。mock 规则的工作是**翻译格式**，不是发明新数据。

### 3.2 因果规则清单（从 CAUSAL_CHAIN 翻译）

#### 规则 1：anomaly/L01 主轴轴承磨损链

```jsonc
{
  "id": "rel-anomaly-l01-bearing",
  "relation_type": "DEVICE__INDICATES__COMPONENT_FAILURE",
  "source_node_id": "device-注塑机-L01",
  "target_node_id": "component-主轴轴承-L01",
  "confidence": 0.90,
  "knowledge_phase": "interview",
  "provenance": "manual_engineer",
  "half_life_days": 90,
  "status": "active",
  "properties": {
    "appliesScenario": ["anomaly"],
    "appliesLine": ["L01"],
    "symptom": "L01 尺寸超差率 5.8%，Cpk 0.85 < 1.0（能力不足）",
    "evidenceRefs": [
      "QUALITY.anomaly.L01.defectRate",
      "QUALITY.anomaly.L01.cpk",
      "EQUIPMENT_HEALTH.anomaly.L01.healthScore",
      "EQUIPMENT_RELIABILITY.anomaly.L01.mtbfHours",
      "PROCESS.anomaly.L01.parameters.温度",
      "PROCESS.anomaly.L01.parameters.压力",
      "ENVIRONMENT.anomaly.L01.tempC",
      "GAGE_RNR.anomaly.L01.rrPct"
    ],
    "causalLayers": [
      "现象：尺寸超差率 5.8%，主缺陷类型为'尺寸超差'（占 42%）",
      "为何尺寸超差？主轴径向跳动 0.03mm 超规（标准 ≤0.02mm）",
      "为何主轴跳动超规？主轴前轴承磨损（间隙增大）",
      "为何轴承磨损加速？自动润滑系统供油不足",
      "根本原因：自动润滑泵滤网堵塞，导致供油不足 → 轴承异常磨损 → 主轴跳动 → 尺寸超差"
    ],
    "rootCause": "自动润滑泵滤网堵塞（设备保养类）",
    "fishbone": {
      "man": [
        "C 班夜班缺陷率比 A 班高 0.012（见 SHIFT_DEVIATION.L01.C）",
        "C 班含新员工未独立（见 PERSONNEL 班长B 郑师傅 level）"
      ],
      "machine": [
        "主轴健康分 0.62 < 0.7 阈值（见 EQUIPMENT.L01.healthScore）",
        "MTBF 降至 180h（正常 480h，见 EQUIPMENT.L01.mtbfHours）",
        "停机事件 3 起：模具卡死/传感器漂移/换模超时"
      ],
      "material": ["近期来料批次切换，但单独不致超差（辅助因素）"],
      "method": [
        "温度 197℃ 超标准 185℃（见 PROCESS.L01.parameters.温度）",
        "压力 4.8MPa 超标准 4.2MPa（见 PROCESS.L01.parameters.压力）"
      ],
      "environment": [
        "车间温度 31℃ 超标准 25±3℃（见 ENVIRONMENT.L01.tempC），空调降级运行",
        "湿度 74% 超注塑宜 ≤60%（见 ENVIRONMENT.L01.humidityPct），塑料颗粒吸潮致气泡缺陷"
      ],
      "measurement": [
        "CMM 三坐标超校准周期 8 个月（标准 6，见 GAGE_RNR.L01.monthsSinceLastCal）",
        "测量系统 R&R=18.5% > 10% 不可接受（见 GAGE_RNR.L01.rrPct）"
      ]
    }
  }
}
```

#### 规则 2：anomaly/L02 温控 PID 漂移链

（从 `scenarios.ts` 1312-1335 行翻译，结构同上，`appliesScenario: ["anomaly"], appliesLine: ["L02"]`，根因"模具寿命校准机制缺失"）

#### 规则 3：crisis/L01 轴承断裂链 + 能耗飙升链（双链）

（从 `scenarios.ts` 1338-1372 行翻译，`appliesScenario: ["crisis"], appliesLine: ["L01"]`，含两条强关联链，根因"预测性维护体系缺失"）

#### 规则 4：crisis/L02 缺料停机链

（从 `scenarios.ts` 1374-1398 行翻译，`appliesScenario: ["crisis"], appliesLine: ["L02"]`，根因"安全库存公式缺供应商交期波动参数"）

#### 规则 5-9：normal 全部为空链

```jsonc
{
  "id": "rel-normal-l01-empty",
  "relation_type": "DEVICE__INDICATES__COMPONENT_FAILURE",
  "source_node_id": "device-注塑机-L01",
  "target_node_id": "none",
  "confidence": 1.0,
  "provenance": "mes_structured",
  "properties": {
    "appliesScenario": ["normal"],
    "appliesLine": ["L01"],
    "symptom": "L01 工况正常",
    "causalLayers": [],
    "rootCause": null
  }
}
```

（L02、L03 同理）

---

## 4. 方法论规则矩阵（C 混合粒度）

### 4.1 完整结构化方法论（granularity=full）

#### DMAIC 方法论

从 `skills/dmaic.ts` 的 `steps` 序列翻译。文件：`methodologies-full.json`。

```jsonc
{
  "topic": "dmaic",
  "confidence": 0.95,
  "source": "mock",
  "granularity": "full",
  "guidance": "DMAIC 是 6Sigma 改善项目管理框架。按 Define→Measure→Analyze→Improve→Control 五阶段产出改善路线图。适用于已识别问题的端到端改善规划。",
  "phases": [
    {
      "id": "D",
      "name": "Define（定义）",
      "goal": "明确改善课题的范围、目标、财务收益",
      "requiredData": [
        { "semantic": "oee", "required": true, "description": "当前 OEE 水平，量化课题严重度" },
        { "semantic": "process_capability", "required": true, "description": "Cpk 值，判断过程能力是否充足" },
        { "semantic": "cost_summary", "required": true, "description": "损失成本，量化财务收益" }
      ],
      "guidance": "D 阶段需量化课题。若 OEE < 目标 或 Cpk < 1.33，课题成立。",
      "confidence": 0.95,
      "blocking": true
    },
    {
      "id": "M",
      "name": "Measure（测量）",
      "goal": "量化当前过程的基线表现",
      "requiredData": [
        { "semantic": "defect_rate", "required": true },
        { "semantic": "process_capability", "required": true },
        { "semantic": "spc_samples", "required": false, "description": "SPC 样本用于计算 σ 水平" }
      ],
      "guidance": "M 阶段建立基线。计算长期 σ = 3×Cpk - 1.5，DPMO = defectRate×10^6。",
      "confidence": 0.95,
      "blocking": true
    },
    {
      "id": "A",
      "name": "Analyze（分析）",
      "goal": "识别根本原因，建立缺陷与输入变量的因果关系",
      "requiredData": [
        { "semantic": "causal_chain", "required": true, "description": "5Why + 鱼骨图分析结果" },
        { "semantic": "process_deviation", "required": false, "description": "工艺参数偏离（辅助）" }
      ],
      "guidance": "A 阶段定位根因。normal 场景无因果链时，phase 标 blocked_by_data。",
      "confidence": 0.85,
      "blocking": true
    },
    {
      "id": "I",
      "name": "Improve（改善）",
      "goal": "实施改善方案，验证效果",
      "requiredData": [
        { "semantic": "causal_chain", "required": true, "description": "基于根因组合对策" }
      ],
      "guidance": "I 阶段基于 A 的根因组合对策。若 Cpk < 1.0，追加工艺参数回调。",
      "confidence": 0.80,
      "blocking": false
    },
    {
      "id": "C",
      "name": "Control（控制）",
      "goal": "建立监控体系，固化改善成果",
      "requiredData": [
        { "semantic": "spc_samples", "required": false },
        { "semantic": "fmea", "required": false, "description": "更新控制计划" }
      ],
      "guidance": "C 阶段建立 SPC 监控 + 标准作业。目标 Cpk=1.33、σ=4。",
      "confidence": 0.80,
      "blocking": false
    }
  ]
}
```

#### OEE 诊断方法论

从 `skills/oee-diagnose.ts` 翻译（4 阶段：取 OEE → 设备取证 → 质量取证 → 工艺取证 → 因果链）。结构同 DMAIC，`topic: "oee_diagnose"`。

#### 停机根因方法论

从 `skills/downtime-root-cause.ts` 翻译。`topic: "downtime_root_cause"`，3 阶段。

#### 多视角根因方法论

从 `skills/multi-perspective-rca.ts` 翻译。`topic: "multi_perspective_rca"`，3 阶段。

#### 成本汇总方法论

从 `skills/cost-summary.ts` 翻译。`topic: "cost_summary"`，1 阶段（单步聚合）。

#### 七大浪费审计方法论

从 `skills/waste-audit.ts` 翻译。`topic: "waste_audit"`，3 阶段。

### 4.2 最小骨架方法论（granularity=minimal）

#### 通用分析方法论

文件：`methodologies-min.json`。

```jsonc
{
  "topic": "general_analysis",
  "confidence": 0.60,
  "source": "mock",
  "granularity": "minimal",
  "guidance": "通用分析兜底。无固定阶段，LLM 根据用户问题自主编排工具。",
  "phases": [
    {
      "id": "understand",
      "requiredData": [
        { "semantic": "oee", "required": false, "fallbackHints": ["若无 OEE 工具，先问用户具体关注什么"] }
      ],
      "guidance": "先理解用户意图，确定分析范围。"
    },
    {
      "id": "investigate",
      "requiredData": [
        { "semantic": "defect_rate", "required": false },
        { "semantic": "equipment_health", "required": false },
        { "semantic": "process_deviation", "required": false }
      ],
      "guidance": "根据意图取相关域数据。LLM 自主决定查哪些域。"
    },
    {
      "id": "conclude",
      "requiredData": [],
      "guidance": "综合证据给出结论。若证据不足，明确说明。"
    }
  ]
}
```

#### 能耗分析（可选最小骨架）

```jsonc
{
  "topic": "energy_analysis",
  "confidence": 0.65,
  "source": "mock",
  "granularity": "minimal",
  "guidance": "能耗专项分析。关注实时功率、峰谷比、单位能耗。",
  "phases": [
    { "id": "baseline", "requiredData": [{ "semantic": "energy_consumption", "required": true }] },
    { "id": "compare", "requiredData": [], "guidance": "与基线对比，识别异常时段。" },
    { "id": "advise", "requiredData": [], "guidance": "给出节能建议。" }
  ]
}
```

### 4.3 方法论覆盖矩阵

| topic | 粒度 | 覆盖场景 | phases 数 | 现有 skill 来源 |
|---|---|---|---|---|
| `dmaic` | full | 全部 9 个 | 5 | `skills/dmaic.ts` |
| `oee_diagnose` | full | 全部 9 个 | 4 | `skills/oee-diagnose.ts` |
| `downtime_root_cause` | full | anomaly/crisis（normal 无停机） | 3 | `skills/downtime-root-cause.ts` |
| `multi_perspective_rca` | full | anomaly/crisis | 3 | `skills/multi-perspective-rca.ts` |
| `cost_summary` | full | 全部 9 个 | 1 | `skills/cost-summary.ts` |
| `waste_audit` | full | 全部 9 个 | 3 | `skills/waste-audit.ts` |
| `general_analysis` | minimal | 全部 | 3 | `skills/general-analysis.ts` |
| `energy_analysis` | minimal | 全部 | 3 | （新增） |

---

## 5. 证据契约矩阵

文件：`evidence-contracts.json`。定义"某结论成立需要什么证据"。

```jsonc
{
  "contracts": [
    {
      "conclusion": "root_cause_identified",
      "requiredEvidence": [
        { "semantic": "causal_chain", "minConfidence": 0.70, "required": true },
        { "semantic": "defect_rate", "minConfidence": 0.80, "required": true },
        { "semantic": "process_deviation", "minConfidence": 0.60, "required": false }
      ],
      "minConfidence": 0.65,
      "source": "mock"
    },
    {
      "conclusion": "capability_sufficient",
      "requiredEvidence": [
        { "semantic": "process_capability", "minConfidence": 0.90, "required": true },
        { "semantic": "spc_samples", "minConfidence": 0.80, "required": false }
      ],
      "minConfidence": 0.85,
      "source": "mock",
      "notes": "Cpk ≥ 1.33 且样本数 ≥ 25 才判定能力充足"
    },
    {
      "conclusion": "D_complete",
      "requiredEvidence": [
        { "semantic": "oee", "minConfidence": 0.90, "required": true },
        { "semantic": "process_capability", "minConfidence": 0.90, "required": true },
        { "semantic": "cost_summary", "minConfidence": 0.80, "required": true }
      ],
      "minConfidence": 0.85,
      "source": "mock"
    },
    {
      "conclusion": "M_complete",
      "requiredEvidence": [
        { "semantic": "defect_rate", "minConfidence": 0.85, "required": true },
        { "semantic": "process_capability", "minConfidence": 0.85, "required": true }
      ],
      "minConfidence": 0.80,
      "source": "mock"
    },
    {
      "conclusion": "A_complete",
      "requiredEvidence": [
        { "semantic": "causal_chain", "minConfidence": 0.70, "required": true }
      ],
      "minConfidence": 0.65,
      "source": "mock",
      "notes": "normal 场景无因果链时，此契约无法满足，A 阶段标 blocked_by_data"
    }
  ]
}
```

---

## 6. 现有工具的 semanticTags 标注清单

基于 `apps/nexusops/tools/` 目录（D10 决策：语义标注在工具侧）。工作量预估：每个工具 2-5 分钟。

| 工具名 | semanticTags | 备注 |
|---|---|---|
| `oee.realtime` | `["oee", "oee_availability", "oee_performance", "oee_quality"]` | 主 OEE 工具 |
| `oee.decompose` | `["oee"]` | OEE 分解 |
| `oee.trend` | `["oee"]` | OEE 趋势 |
| `oee.by_shift` | `["oee", "shift_deviation"]` | 班次维度 |
| `equipment.health` | `["equipment_health"]` | 第一取证点 |
| `equipment.health_trend` | `["equipment_health"]` | |
| `equipment.mtbf` | `["equipment_reliability"]` | |
| `equipment.failure_predict` | `["equipment_reliability"]` | |
| `equipment.downtime` | `["oee_availability", "downtime_events"]` | |
| `quality.defect_rate` | `["defect_rate"]` | 第一取证点 |
| `quality.defects` | `["defect_rate"]` | |
| `quality.cp_cpk` | `["process_capability"]` | 第一取证点 |
| `quality.fpy` | `["defect_rate"]` | |
| `quality.five_why` | `["causal_chain"]` | |
| `quality.fishbone` | `["causal_chain"]` | |
| `quality.spc` | `["spc_samples"]` | |
| `quality.by_shift` | `["defect_rate", "shift_deviation"]` | |
| `process.parameters` | `["process_deviation"]` | 第一取证点 |
| `process.deviation` | `["process_deviation"]` | |
| `process.fmea` | `["fmea"]` | |
| `energy.realtime` | `["energy_consumption"]` | |
| `energy.trend` | `["energy_consumption"]` | |
| `material.wip` | `["wip_level"]` | |
| `material.shortage` | `["wip_level", "supply_risk"]` | |
| `schedule.current` | `["schedule_attainment"]` | |
| `cost.summary` | `["cost_summary"]` | |

（完整清单在 Phase 0 实现时补全，约 40+ 工具）

---

## 7. 企业工具索引（tool-index.json 示例）

由 `syncToolIndex` 自动生成（企业实施后回写 relos）：

```jsonc
{
  "version": "1.0",
  "enterprise": "nexusops-mock-demo",
  "syncedAt": "2026-07-03T13:00:00Z",
  "tools": [
    {
      "name": "quality.cp_cpk",
      "semanticTags": ["process_capability"],
      "description": "查询过程能力指数 Cp/Cpk",
      "whenToUse": { "triggers": ["Cpk", "过程能力", "能力指数"], "notFor": [] }
    },
    {
      "name": "oee.realtime",
      "semanticTags": ["oee"],
      "description": "查询实时 OEE 综合指标",
      "whenToUse": { "triggers": ["OEE", "综合效率"], "notFor": [] }
    }
    // ... 全部 domain 工具
  ]
}
```

---

## 8. 迁移工作量估算

| 工作项 | 数据量 | 单项工时 | 总工时 |
|---|---|---|---|
| 因果规则翻译（CAUSAL_CHAIN → relations.json） | 9 条（含空链） | 10 分钟 | 1.5 小时 |
| 完整结构化方法论（6 个 topic） | 6 份 | 30 分钟 | 3 小时 |
| 最小骨架方法论（2 个 topic） | 2 份 | 15 分钟 | 0.5 小时 |
| 证据契约 | 5 条 | 10 分钟 | 1 小时 |
| 工具 semanticTags 标注 | 40+ 工具 | 3 分钟 | 2 小时 |
| **合计** | — | — | **~8 小时** |

这些工作在 Phase 0 完成，产出 `data/relos-mock/` 目录下的全部 JSON 文件。

---

## 9. 验证规则

mock 规则的完整性校验（Phase 0 测试覆盖）：

1. **场景覆盖**：每个 `(scenarioId, line)` 组合都能查到因果规则（含空链）
2. **方法论完整性**：每个 full 方法论的 phases 都有 `requiredData`，且每个 `semantic` 在工具标注清单里能找到
3. **证据契约闭环**：每个方法论 blocking phase 的"完成态"都有对应的 `EvidenceContract`
4. **置信度合理**：`provenance` 与 `confidence` 范围一致（对齐 relos §7.2）
