# 17 - Skill 沉淀机制（trace → skill）

> 配套文档：[15-harness-engineering.md](15-harness-engineering.md) §15.6 L 层、[16-nexusops.md](16-nexusops.md) NexusOps 应用。

## 17.1 术语对齐

| 词 | 在 let-it-flow 里对应什么 | 适合沉淀吗 |
|----|--------------------------|-----------|
| loop | 固定间隔/事件唤醒的轮询 | 不适合。loop 是时序容器，不携带业务步骤语义 |
| workflow / dag | 静态 DAG（planner+executor） | 部分。DAG 是预编译结构，本身是产物，不存在"从运行中沉淀" |
| **trace（轨迹）** | `StepTrace[]`（ReAct 每步的 thought→toolCall→observation） | **最适合**。这是"一次成功执行"的可复用模式来源 |
| **skill** | `SkillConnector`（已结构化的 `SkillStep[]`） | 这是沉淀的产物形态 |

数据流：`StepTrace[]` → 候选 `SkillStep[]` → 确认 → 持久化 `SkillConnector`。源是 trace，产物是 skill。内部统一用 "trace → skill 沉淀"。

## 17.2 触发模型：不对称的混合

**以"用户主动触发"为主干，"自动识别"为低频、保守的提示通道。**

```mermaid
flowchart LR
    Trace["完成一次 ReAct<br/>StepTrace[] 落库"] --> Sig{"信号采集<br/>(频次/成本/稳定性)"}
    Sig -->|"命中阈值"| Suggest["低频、保守地<br/>提示用户"]
    Suggest --> UserDecide{"用户决定"}
    UserDecide -->|"主动: 用户直接说<br/>'把这段沉淀'"--> Extract
    UserDecide -->|"接受提示"| Extract
    UserDecide -->|"忽略"| End["静默,不打扰"]
    Extract["提取候选 SkillStep[]<br/>(trace → 步骤序列)"] --> Confirm["确认门:<br/>可编辑/裁剪/重命名"]
    Confirm --> Persist["持久化为 draft SkillConnector<br/>(影子模式)"]
    Persist --> Promote{"N 次成功调用<br/>且无回归"} --> PromoteSkill["升级为 active skill<br/>进入 toolTiers"]
```

主动触发走快通道（一步沉淀），自动识别走慢通道（提示 → 提取 → 确认 → draft 影子 → 验证后转正）。

## 17.3 自动识别：不做分类器

不训练分类器判"这段 trace 值不值得沉淀"（无标注、无反馈闭环的死胡同）。用"信号阈值 + 去重 + 显式确证"三件套。

### 17.3.1 三个硬信号（AND）

| 信号 | 计算方式 | 阈值 |
|------|----------|------|
| 工具序列重复度 | trace 压成 toolName 序列，4-gram 聚类 | 簇内 ≥3 次 |
| 成本占比 | n-gram 长度 / 序列长度 | >60% |
| 成功稳定性 | finishReason ∈ {finalize, no_tool_call} 且无 precondition_unmet | ≥80% |

三个**同时**命中才提示。任意单信号（如纯重复度）都会误报。

### 17.3.2 反信号（一票否决）

| 反信号 | 来源 |
|--------|------|
| inferred 硬结论 | EvidenceEnvelope.confidence=inferred |
| HITL 决策 | toolCall.rejected=true |
| governance 阻断 | result.blocked/governance_blocked=true |
| skill 部分失败 | result._skill.errors 非空 |

任一命中即否决，候选不登记。

### 17.3.3 跨会话去重降权

同签名候选只记一条，occurrences 累加。用户忽略的候选 `dismissedCount` 累加，达阈值（2 次）后不再提示。

## 17.4 draft 影子运行

沉淀产物带 `status: "draft"` 标记。draft skill 执行时：

- 输出标记 `_shadow: true`（主循环/前端识别"试运行结果，不直接采用"）
- description 标记 `[Skill·draft]`
- 连续 N 次成功（无反信号）转正为 active（由 SkillRegistry 计数）
- 连续 N 次失败删除（降级）

这一步把"自动识别准确率"问题卸掉：识别错也不会造成伤害，顶多浪费几次影子计算。用可回滚的试运行替代不可回滚的概率判定。

## 17.5 模块落点

| 模块 | 文件 | 职责 |
|------|------|------|
| SkillConnector + createSkill | `src/agent/skill-bridge.ts` | skill 数据结构 + 执行（含 status/影子模式） |
| skill-miner | `src/agent/skill-miner.ts` | 候选挖矿（三信号 AND + 反信号否决） |
| SkillRegistry | `src/agent/skill-registry.ts` | 跨会话去重/降权/draft 升级计数（本地 JSON 持久化） |
| skill-confirm | `src/agent/skill-confirm.ts` | 候选转 SkillStep + 确认门事件 |
| 应用挂接 | `apps/nexusops/server/boot.ts` | 每 run 后挖矿 + emit 候选提示 |
| 应用 skill 池 | `apps/nexusops/skills/index.ts` | 手写 skill + registry active skill 合并 |

## 17.6 存储

- 候选 + draft/active skill 记录存 `data/skills.json`（本地，不入 git）
- 持久化失败降级为内存态（不阻断主流程）
- 文件损坏降级为空内存态（不抛错）

## 17.7 确认门事件

发现候选时 emit `extension` 事件 `skill_candidates`（前端可渲染确认 UI）：

```json
{
  "name": "skill_candidates",
  "version": "1.0",
  "data": {
    "candidates": [
      { "signature": "oee.realtime→oee.decompose→...", "occurrences": 5, "sampleSequence": [...] }
    ],
    "hint": "检测到可复用模式，是否沉淀为 skill？"
  }
}
```

用户确认（可编辑 name/description/steps）后回传，由 `acceptToDraftSkill` 转成 draft SkillConnector。
