---
title: OEE 诊断标准流程（A3）
category: 02-改善项目/改善基准数据
tags: [OEE, 诊断, A3, 流程, 标准化]
version: v3
last_updated: 2026-06-01
---

# OEE 诊断标准流程（A3 报告模板）

适用场景：某产线 OEE 持续低于目标（如 <75%），需系统性根因分析。

## 7 步标准流

1. **现状把握**：`oee.realtime` + `oee.history`（确认是突发还是长期）
2. **损失分解**：`oee.decompose` 定位最大损失项（可用/性能/质量）
3. **可用率取证**：若可用率低 → `equipment.downtime` 取停机原因 + `equipment.mtbf`
4. **性能取证**：若性能率低 → `process.deviation` 查工艺参数 + `process.standard_vs_actual`
5. **质量取证**：若质量率低 → `quality.pareto` 查缺陷分布 + `quality.cp_cpk`
6. **根因综合**：交叉验证，避免单点归因（5M1E 框架：`quality.root_cause_5m1e`）
7. **建议产出**：`nexus_advise` 输出结构化改善建议

## 关键判定规则

- 停机原因 ≥ 3 类且无明显主导 → 多因素问题，需并行攻关
- 工艺偏差 > 5% → 优先调工艺（高执行度）
- Cpk < 1.0 → 过程能力严重不足，需停机整改
- MTBF 下降 > 30% → 设备进入可靠性恶化期，预测性维护

## 输出要求

诊断报告必须包含：
- 现状数据（带 freshness/confidence 标注）
- 根因链（每个根因引用对应证据）
- 改善建议（含 impact / executionScore）
- 验证方案（改善后如何复测）

## 关联工具

- skill.oee_diagnose（沉淀的标准化诊断流，一键调用）
