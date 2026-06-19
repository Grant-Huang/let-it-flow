---
title: 节拍与CT标准
category: 01-现场状态
tags: [节拍, CT, Takt, 产线平衡]
version: v1
---

# 节拍（Takt）与周期时间（CT）标准

## 定义

- **Takt Time（节拍时间）**：客户需求速率决定的生产节奏
  - 公式：Takt = 可用时间 / 客户需求量
  - 例：480min/班 ÷ 480件/班 = 1min/件

- **Cycle Time（CT，周期时间）**：完成一个产品实际耗时
  - CT 应 ≤ Takt，否则跟不上客户需求

## 诊断规则

| CT vs Takt | 状态 | 行动 |
|------------|------|------|
| CT ≤ 0.9×Takt | 健康 | 维持 |
| 0.9×Takt < CT ≤ Takt | 紧张 | 监控 |
| CT > Takt | 跟不上 | **优先攻关瓶颈工位** |

## 产线平衡

- 瓶颈工位决定整线 CT
- 平衡率 = 各工位时间之和 / （工位数 × 最大工位时间）
- 平衡率 < 80% 说明存在明显瓶颈/闲置

## 关联工具

- `schedule.ct_vs_takt`：CT vs Takt 对照
- `schedule.bottleneck_resource`：瓶颈资源识别
