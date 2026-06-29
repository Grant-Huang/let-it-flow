---
title: Cpk 不足致尺寸超差（A3 案例）
category: 02-改善项目/A3报告库
tags: [案例, 工艺, Cpk, 尺寸超差, 质量]
problem_type: [工艺致质量]
version: v1
date: 2026-06-19
---

# 案例：Cpk 不足致尺寸超差

## 问题现象

L01 产线（anomaly 场景）缺陷率升至 5.8%，**TOP1 缺陷为"尺寸超差"**（45 件，占 42%）。过程能力指数 **Cpk=0.85**（标准 ≥1.33，<1.0 为严重不足），说明工艺能力不足以稳定产出合格品。

## 诊断过程

1. `quality.defect_rate`：缺陷率 5.8%，FPY 90.5%，均超标
2. `quality.pareto`：尺寸超差是关键少数（42%），其次表面气泡（26%）
3. `quality.cp_cpk`：Cp=1.1, Cpk=0.85，assessment=inadequate（严重不足）
4. `quality.spc`：控制图显示**连续 3 点超 UCL**，过程不受控（ruleViolations）
5. `process.parameters`：温度 actual=197℃（标准 185℃，**偏离 +12℃**），压力 4.8MPa（标准 4.2，偏离）
6. `process.deviation`：偏差分 0.42（高）

## 根因

**5Why**：
- Why1 为什么尺寸超差？→ 过程能力不足（Cpk=0.85）
- Why2 为什么 Cpk 不足？→ 过程波动大，均值偏移
- Why3 为什么波动大？→ 工艺参数偏离标准（温度 +12℃）
- Why4 为什么温度偏离？→ 温控回路漂移，未及时回调
- Why5 为什么没及时回调？→ 无参数偏离的实时预警，靠人工巡检

**根因**：工艺参数（温度/压力）偏离标准窗口，导致过程能力恶化；且无实时预警，发现滞后。

## 关键判定

- **Cpk < 1.33** = 能力不足（需改善系统，非救火）
- **Cpk < 1.0** = 严重不足（必须立即停产整顿或 100% 筛选）
- **控制图有判异** = 先排除特殊原因，再评估能力

## 对策

### 临时
- `mcp.process.adjust_parameters`：将温度回调至 185℃、压力回调至 4.2MPa（HITL 确认）
- `mcp.qms.quarantine`：隔离可疑批次待复检

### 永久
1. **参数实时监控**：温度/压力偏离 ±5% 即报警（接入 SPC 控制图）
2. **温控回路改造**：校准或更换温控阀，消除漂移根源
3. **能力提升**：改善后 Cpk 目标 ≥1.33，达不到则考虑工艺重设计

## 教训沉淀

- **Cpk 是过程"体检指标"**：<1.33 就该预警，别等缺陷率爆了才发现
- **参数偏离是 Cpk 恶化的主因**：监控 `process.deviation` 比监控缺陷率更前置
- **控制图不受控时 Cpk 失真**：必须先排除特殊原因再算 Cpk

## 适用工具调用模式

```
quality.defect_rate → quality.pareto → quality.cp_cpk → quality.spc → process.parameters → process.deviation
↓ (对策)
mcp.process.adjust_parameters → quality.cp_cpk (复检能力)
mcp.qms.quarantine (止损)
```

## 关联

- 工具模板：`03-精益知识/工具模板/SPC控制图模板.md`、`PFMEA模板.md`
- 术语：`03-精益知识/术语表/精益术语表.md`（Cp/Cpk 定义）
- 前置条件：`05-推理辅助/约束条件模板.md`（质量诊断证据强度）
