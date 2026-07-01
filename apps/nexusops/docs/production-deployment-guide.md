# NexusOps 生产部署指南

本文档梳理当前 mock 实现与生产所需真实数据源之间的差距，帮助工程团队规划上线替换路径。

---

## 一、Mock 工具清单 → 生产替换

### 1.1 OEE 域（`tools/domains/oee.ts`）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `oee.realtime` | `scenarios.ts` 静态常量 | MES 实时 OEE API（`/mes/oee/realtime?line=&shift=`） |
| `oee.all_lines` | 静态多产线对象 | MES 多线聚合 API 或 MOM 仪表盘 |
| `oee.trend` | 基于当前值插值 | MES 历史时序库（如 InfluxDB / Historian） |
| `oee.shift_comparison` | `getOEEByShift()` 静态数据 | MES 班次报表 API |
| `oee.availability_loss` | 按 OEE 固定比例拆分 | MES 停机事件日志（MTBF/MTTR 实测） |
| `oee.performance_loss` | 同上 | MES 速率监控 / 节拍对比 |
| `oee.quality_loss` | 同上 | QMS 不良批次统计 |
| `oee.report_html` | 聚合 mock 数据生成 HTML | 同上各域真实 API，HTML 模板无需替换 |

**替换优先级**：先 `oee.realtime` → `oee.all_lines` → trend 类。

### 1.2 设备域（`tools/domains/equipment.ts`）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `equipment.status` | `scenarios.ts` 静态设备状态 | EAM（Enterprise Asset Management）实时设备状态 API |
| `equipment.health` | 静态 `healthScore` + 固定故障风险 | IoT 平台（振动/温度/电流传感器） + PHM 预测模型 |
| `equipment.downtime` | 静态停机事件列表 | MES 停机日志表（`t_downtime_event`） |
| `equipment.maintenance` | 静态维护记录 | EAM 维护工单历史 |
| `equipment.spare_parts` | 静态备件库存 | ERP 备件库存模块（WM） |
| `equipment.vibration` | 固定值 | IoT 振动传感器实时数据流 |
| `equipment.failure_prediction` | 固定 `failureRisk30d` | ML 故障预测服务（基于传感器历史训练） |

### 1.3 质量域（`tools/domains/quality.ts`）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `quality.defects` | `scenarios.ts` 静态缺陷列表 | QMS 缺陷记录表（`t_defect_detail`） |
| `quality.pareto` | 同上，帕累托排序 | QMS 缺陷统计报表 |
| `quality.cpk` | 静态 Cpk 值 | SPC 系统实时过程能力数据 |
| `quality.spc` | 固定值 | SPC 系统 API（UCL/LCL/控制图点位） |
| `quality.five_why` | `getCausalChain()` 预置 9 条链 | **见第三节：因果链** |
| `quality.fishbone` | 同上 | 同上 |
| `quality.incoming` | 静态来料检验数据 | QMS 来料检验记录（IQC 模块） |

### 1.4 工艺域（`tools/domains/process.ts`）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `process.parameters` | `scenarios.ts` 静态工艺参数 | MES/SCADA 实时工艺参数采集（温度/压力/速度等） |
| `process.deviation` | 基于静态参数计算 | 同上，与 PLM 标准值实时对比 |
| `process.recipe` | 静态配方数据 | PLM 工艺配方库（标准参数窗口） |
| `process.standard_vs_actual` | 静态对比 | MES+PLM 联合 API |
| `process.capability` | 静态 Cpk/Sigma | SPC 过程能力实时计算 |
| `process.adjustment` | `actionStore` mock 副作用 | MES 工艺参数写入 API（需 MCP 动作授权） |
| `process.fmea` | `getProcessFmea()` 静态数据 | PLM PFMEA 模块（AIAG-VDA 格式） |
| `process.control_plan` | 静态控制计划 | PLM 控制计划模块 |
| `process.quality_impact` | 硬编码注塑规则 | 工艺专家知识库 + PLM FMEA 机制描述（可半自动生成） |

> `process.quality_impact` 中的机制规则（温度↑→缩水，压力↑→飞边等）为通用注塑工艺规律，生产环境可扩充到企业特定产品的 PFMEA 条目。

### 1.5 能耗/排产/物料域

| 域 | Mock 来源 | 生产替换目标 |
|----|---------|------------|
| `energy.*` | 静态常量 | 能源管理系统（EMS）或电表实时数据 |
| `production.*` | `scenarios.ts` 排产数据 | MES 排产模块（APS 集成） |
| `material.*` | 静态库存风险值 | ERP WM 模块（库存量/短缺预警）|

### 1.6 MCP 动作工具（`tools/domains/mcp-actions.ts`）

当前所有 `mcp.*` 动作工具均为 mock，执行后只写入 `actionStore` 内存。生产替换：

| MCP 工具 | 目标系统 | 注意 |
|---------|--------|------|
| `mcp.mes.schedule_work_order` | MES 工单 API | 需工单号参数 |
| `mcp.mes.changeover` | MES 换模调度 | 需停线窗口授权 |
| `mcp.mes.reallocate_capacity` | APS/MES | 影响多产线，需 HITL |
| `mcp.erp.purchase_request` | ERP MM 模块 | 采购申请审批流 |
| `mcp.erp.material_issue` | ERP WM 模块 | 库存扣减，不可撤销 |
| `mcp.qms.quarantine` | QMS | 批次隔离，影响出货 |
| `mcp.qms.rework_order` | QMS | 返工工单创建 |
| `mcp.qms.scrap_batch` | QMS | **destructive**，批量报废 |
| `mcp.eam.maintenance_order` | EAM | 维护工单，影响设备可用率 |
| `mcp.eam.spare_part_order` | ERP 备件 | 备件采购申请 |
| `mcp.eam.stop_line` | MES | **destructive**，停线，需双重确认 |
| `mcp.process.adjust_parameters` | MES/SCADA | 实时写参数，需工艺工程师授权 |

所有 destructive 动作在 `buildNexusGovernance()` 中已配置需要 HITL 二次确认，生产部署时检查 `governance.ts` 的 `requireConfirmation` 配置是否完整。

---

## 二、知识库（KB）替换指引

当前 KB vault 位于 `apps/nexusops/tools/knowledge/vault/`，为演示用 seed 内容。

### 2.1 现有 seed 目录结构

```
vault/
├── sop/               # 标准操作规程（mock：换模SOP等）
├── quality/           # 质量方法论（mock：缺陷分析A3模板）
├── equipment/         # 设备手册摘录（mock：注塑机维护要点）
├── terminology/       # 术语表（mock：OEE/精益术语）
└── methods/           # 分析方法（mock：5Why、鱼骨图指引）
```

### 2.2 生产填充要求

| 目录 | 填充内容 | 推荐来源 |
|------|---------|--------|
| `sop/` | 各产线真实 SOP 文件（换模、点检、清洁、首件确认等） | 企业文控系统导出 PDF/Word 转 Markdown |
| `quality/` | 历史 8D 报告、A3 分析、缺陷归纳总结 | QMS 历史报告 |
| `equipment/` | 关键设备手册、故障代码表、维护保养规程 | 设备厂商文档 + EAM 维护记录 |
| `terminology/` | 企业内部术语、产品代号、产线编号规则 | 企业标准化文件 |
| `methods/` | 企业特定分析模板、经过验证的改善案例 | 精益/质量部门积累 |

### 2.3 KB 集成方式

当前使用 `ObsidianProvider` 读取本地 `.md` 文件。生产可替换为：
- **Confluence**：使用 `McpKnowledgeProvider` 对接 Confluence MCP server
- **SharePoint**：自定义 provider 调用 Graph API
- **企业内网知识库**：实现 `IKnowledgeProvider` 接口，约 50 行代码

---

## 三、因果链（Causal Chain）替换指引

### 3.1 现状

当前 `CAUSAL_CHAIN` 定义在 `tools/mock-data/scenarios.ts`，覆盖：
- **场景维度**：normal / anomaly / crisis（3个）
- **产线维度**：L01 / L02 / L03（3条）
- **总计**：9个场景×产线组合，每组包含：
  - `chains`：5Why 因果链（anomaly/crisis 各有 1 条，normal 为空）
  - `fishbone`：5M1E 鱼骨图（Machine/Method/Man/Material/Measurement/Environment 六维）

当前仅 anomaly+L01 场景有完整的 5Why 链：
```
根因：自动润滑泵滤网堵塞（设备保养类）
路径：尺寸超差→主轴跳动→轴承磨损→润滑不足→滤网堵塞
```

### 3.2 生产积累要求

生产环境下，因果链是最高价值的知识资产，建议按以下优先级积累：

**第一阶段（上线即准备）**：
- 收集过去 2 年所有已结案的 8D / A3 报告，提取"根本原因→机制路径"
- 按产品族 × 缺陷类型建立基础因果链库（目标：每条产线 10+ 条高频根因链）

**第二阶段（持续运营）**：
- 每次 5Why 分析完成后，由工艺工程师录入因果链（表单化录入 → 自动生成结构）
- 建议字段：`rootCause`、`layers[5Why层级]`、`fishbone`、`线别`、`产品族`、`发生日期`、`验证状态`

**第三阶段（智能化）**：
- 基于历史案例训练分类模型，自动推荐最相近因果链
- 与 quality.five_why 工具联动，实现"症状→自动匹配历史根因"

### 3.3 因果链数据结构参考

```typescript
// 与 CausalChainData（scenarios.ts）兼容的生产格式
{
  chains: [{
    method: "5why",
    layers: [
      "现象：[缺陷描述]",
      "为何 [现象]？[直接原因]",
      "为何 [直接原因]？[中间原因]",
      "为何 [中间原因]？[深层原因]",
      "根本原因：[根本原因]",
    ],
    rootCause: "[根本原因简述]（[分类：设备/工艺/人员/物料/管理]）",
  }],
  fishbone: {
    machine:  ["[设备相关因素]"],
    method:   ["[工艺/方法相关因素]"],
    man:      ["[人员相关因素]"],
    material: ["[物料相关因素]"],
    measurement: ["[检测相关因素]"],
    environment: ["[环境相关因素]"],
  },
}
```

---

## 四、硬编码基础数据替换

### 4.1 设备基础数据（`EQUIPMENT` 常量）

当前硬编码：MTBF=450h、健康分计算方式、故障风险模型。

生产替换：
- MTBF/MTTR：从 EAM 停机记录实时计算（滚动 90 天）
- 健康分：IoT + PHM 服务实时输出（0-1 归一化）
- 故障风险：ML 模型预测服务（基于振动/温度/电流特征）

### 4.2 质量基线（`QUALITY` 常量）

当前硬编码：不良率目标 0.3%、Cpk 基线 1.33、主要缺陷类型。

生产替换：
- 目标值：从 QMS 产品规格/客户协议中读取
- 实测值：SPC 系统实时数据
- 缺陷类型权重：QMS 历史统计（动态帕累托）

### 4.3 工艺标准（`PROCESS` 常量）

当前硬编码：温度标准 185°C、压力标准 65MPa 等。

生产替换：
- 工艺标准窗口（上/下限）：PLM 工艺配方模块
- 实测值：MES/SCADA 实时采集（每 5 秒或每模次）
- 偏差阈值：PLM 控制计划中的 `reactionPlan` 触发条件

### 4.4 产线配置（`LINE_CONFIG`）

当前硬编码：L01/L02/L03 三条产线。

生产替换：
- 从 ERP/MES 动态读取产线主数据（线别码、设备清单、产品族映射）
- 支持动态注册新产线，无需修改代码

---

## 五、数据替代优先级路线图

```
第一优先（影响核心诊断准确性）：
  ✦ process.parameters → SCADA 实时采集
  ✦ quality.five_why → 真实因果链库（历史 8D/A3）
  ✦ equipment.health → IoT + PHM 服务
  ✦ oee.realtime → MES OEE API

第二优先（影响建议可执行性）：
  ✦ 所有 mcp.* 动作工具 → 真实系统写入 API
  ✦ KB vault → 企业 Confluence/SharePoint
  ✦ quality.defects → QMS 实时缺陷

第三优先（影响分析深度）：
  ✦ equipment.failure_prediction → ML 预测服务
  ✦ energy.* → EMS
  ✦ production.* → APS
  ✦ process.quality_impact 规则库 → PLM PFMEA 条目

持续积累（知识资产）：
  ✦ 因果链库：每完成一次 5Why 分析即录入
  ✦ SOP 库：每版本更新同步 vault
  ✦ 历史案例：季度批量导入
```

---

## 六、部署检查清单

上线前确认：

- [ ] `NEXUS_MCP_SERVERS` 环境变量配置了真实 MCP server 地址
- [ ] `OBSIDIAN_VAULT_PATH` 指向企业 KB 路径（或已换成 Confluence provider）
- [ ] `ANTHROPIC_API_KEY` 已配置生产密钥（或企业 LLM 网关）
- [ ] `governance.ts` 中所有 destructive 动作均配置了 `requireConfirmation: true`
- [ ] `preconditions.ts` 中前置条件检查逻辑与真实数据结构对齐
- [ ] 因果链库已有 ≥10 条历史根因（否则 `quality.five_why` 对真实问题输出空结果）
- [ ] 所有 mock `getData` 函数已替换为真实 API 调用（逐工具检查 `tool-factory.ts` 注册）
- [ ] MCP 动作工具已完成集成测试（在 staging 环境验证 HITL 流程）
- [ ] `oee.report_html` 生成的 HTML 中 `postMessage` 动作按钮指向正确的 MCP 工具名

---

*本文档随实现迭代更新，以 `apps/nexusops/tools/mock-data/scenarios.ts` 中的 mock 数据结构为参考基准。*
