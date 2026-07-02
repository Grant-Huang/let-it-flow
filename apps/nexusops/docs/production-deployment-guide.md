# NexusOps 生产部署指南

本文档梳理当前 mock 实现与生产所需真实数据源之间的差距，帮助工程团队规划上线替换路径。

**参考基准**：以 `apps/nexusops/tools/mock-data/scenarios.ts`（15 个数据域 × 3 场景 × 3 产线）和 `apps/nexusops/tools/domains/` 下 9 个工具域文件为唯一事实来源。当前已注册 **89 个工具**（77 个 `buildNexusTools()` 返回的域/核心工具 + 12 个独立注册的 MCP 动作工具）。

---

## 一、Mock 工具清单 → 生产替换

### 1.1 OEE 域（`tools/domains/oee.ts`，共 12 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `oee.realtime` | `OEE_BASE` 静态常量（含 availability/performance/quality 三率） | MES 实时 OEE API（`/mes/oee/realtime?line=&shift=`） |
| `oee.history` | 基于 `trend7d[7]` 静态数组 | MES 历史时序库（InfluxDB / Historian / PI System） |
| `oee.decompose` | 按 OEE 三率固定拆分损失瀑布 | MES 损失瀑布报表（需基于停机事件 + 速率 + 质量实测计算） |
| `oee.bottleneck` | `getOEEAllLines()` 排序取最低 | MOM 多线聚合看板 / APS 瓶颈分析 |
| `oee.trend` | 用 trend7d[0] vs 当前做环比 | MES 历史对比 API（周/月维度） |
| `oee.by_shift` | `getOEEByShift()` = 基准 + `SHIFT_DEVIATION` 偏移 | MES 班次报表 API |
| `oee.by_line` | `getOEEAllLines()` 原始矩阵 | MOM 多线聚合 API |
| `oee.compare` | 两线 OEE 差值 | MOM 产线对比 API |
| `oee.availability_loss` | 固定比例（planned 4% + changeover 2%） | MES 停机事件日志分类汇总（MTBF/MTTR 实测） |
| `oee.performance_loss` | 固定比例（minorStops 6% + idling 2%） | MES 速率监控 / 小停机事件流 |
| `oee.quality_loss` | 按 (1-quality) × 固定比例（scrap 60% / rework 30% / downgrade 10%） | QMS 不良批次统计（按处置类型分） |
| `oee.report_html` | 聚合各域 mock 数据生成自包含 HTML | HTML 模板无需替换，数据源替换后自动反映真实数据 |

**替换优先级**：先 `oee.realtime` → `oee.history` → `oee.decompose` → 班次/产线聚合类。

> **注意**：旧版文档中的 `oee.all_lines` / `oee.shift_comparison` 工具名不存在，实际为 `oee.by_line` / `oee.by_shift`。

### 1.2 设备域（`tools/domains/equipment.ts`，共 9 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `equipment.status` | `EQUIPMENT.status` 静态枚举（running/idle/down） | EAM 实时设备状态 API |
| `equipment.downtime` | `downtimeEvents[]` 静态事件列表 | MES 停机日志表（`t_downtime_event`，含原因码/时长/时间戳） |
| `equipment.mtbf` | `mtbfHours` 静态值，基线固定 450h | EAM 停机记录滚动 90 天计算 |
| `equipment.mttr` | `mttrMinutes` 静态值，基线固定 45min | EAM 维修工单历史计算 |
| `equipment.maintenance_log` | 按 healthScore 分支生成静态日志 | EAM 维护工单历史（PM/CM 记录） |
| `equipment.health` | `healthScore` + 派生伪信号（vibration/temp/current 从 healthScore 偏移） | IoT 平台（振动/温度/电流传感器分通道） + PHM 预测模型 |
| `equipment.failure_predict` | 固定 `failureRisk30d` | ML 故障预测服务（基于传感器历史特征训练） |
| `equipment.spare_parts` | 按 healthScore 分支生成静态备件清单 | ERP 备件库存模块（WM） |
| `equipment.alarm_history` | 按 healthScore 分支生成静态报警码 | MES/EAM 报警事件流（含故障码字典） |

> **注意**：旧版文档列出的 `equipment.vibration` 工具不存在。振动信号只在 `equipment.health` 的 `signals.vibration` 字段内，没有独立工具。生产环境若需独立振动分析，建议新增 `equipment.vibration_spectrum` 工具对接 FFT 频谱服务。

### 1.3 质量域（`tools/domains/quality.ts`，共 13 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `quality.defect_rate` | `QUALITY.defectRate/fpy/scrapRate` 静态值 | QMS 缺陷记录表（`t_defect_detail`）实时统计 |
| `quality.pareto` | `topDefects[]` 静态缺陷类型排序 | QMS 缺陷统计报表（动态帕累托） |
| `quality.spc` | 30 个连续样本 + Nelson 八大判异规则 + 多尺寸支持（`SPC_SAMPLES`） | SPC 系统 API（UCL/LCL/控制图点位，多尺寸支持） |
| `quality.cp_cpk` | `cp/cpk` 静态值，USL/LSL 硬编码 10.2/9.8 | SPC 过程能力实时计算（按产品规格动态读取 USL/LSL） |
| `quality.fpy` | `fpy` 静态值 | QMS 首次合格率统计（按班次/批次） |
| `quality.scrap` | `scrapRate` × 1000 × 45 元（硬编码单价） | QMS 报废记录 + ERP 成本模块（实际单价） |
| `quality.rework` | `(1-fpy) - scrapRate` 派生，工时固定 0.3h/件 | QMS 返工工单 + MES 返工工时采集 |
| `quality.inspection` | 静态首检/巡检/末检记录（巡检间隔硬编码 2h） | QMS 检验记录模块（首检/巡检/末检，按检验计划） |
| `quality.root_cause_5m1e` | 按 cpk<1.0 分支返回布尔可疑标签 | 专家系统 / FMEA 知识库（可半自动推理） |
| `quality.five_why` | `CAUSAL_CHAIN.chains` 预置因果链 | 历史案例库（见第三章） |
| `quality.fishbone` | `CAUSAL_CHAIN.fishbone` 预置六分支 | 历史案例库 + 专家录入 |
| `quality.sigma_level` | 从 Cpk 派生（Z.st=3×Cpk，Z.lt=Z.st-1.5）+ DPMO | SPC 系统 Sigma 水平实时计算（6Sigma DMAIC M 阶段） |
| `quality.dpmo` | `defectRate × 1M` + 按 topDefects 分解贡献 | QMS DPMO 趋势报表（按缺陷类型分解） |

> **注意**：旧版文档中的 `quality.defects`（正确名 `quality.defect_rate`）和 `quality.incoming`（不存在）需修正。来料检验（IQC）若需要，建议新增 `quality.iqc` 工具对接 QMS 来料检验模块。

### 1.4 工艺域（`tools/domains/process.ts`，共 9 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `process.parameters` | `PROCESS.parameters` 静态值（温度/压力/速度等） | MES/SCADA 实时工艺参数采集（每模次或每 5 秒） |
| `process.deviation` | 基于静态参数计算偏差 + `deviationScore` | MES+PLM 实时对比 |
| `process.recipe` | 静态配方（standard × 5% 公差） | PLM 工艺配方库（标准参数窗口 + 实际公差） |
| `process.standard_vs_actual` | 静态并排对照 | MES+PLM 联合 API |
| `process.capability` | `PROCESS.capability` 静态 Cpk | SPC 过程能力实时计算（参数维度） |
| `process.adjustment` | 基于偏差给出回调建议（向 standard 靠拢） | 工艺工程师知识库 + PLM 反应计划 |
| `process.fmea` | `getProcessFmea()` 从 PROCESS 派生（AIAG-VDA S/O/D + AP） | PLM PFMEA 模块（AIAG-VDA 格式） |
| `process.control_plan` | 静态控制项（从 parameters keys 派生） | PLM 控制计划模块 |
| `process.quality_impact` | 硬编码注塑规则（温度↑→缩水，压力↑→飞边等） | 企业特定产品 PFMEA 条目 + 工艺专家知识库 |

> `process.quality_impact` 的机制规则为通用注塑工艺规律，生产环境需扩充到企业特定产品族的 PFMEA 条目。

### 1.5 能耗域（`tools/domains/energy.ts`，共 9 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `energy.realtime` | `ENERGY.realtimeKw/baselineKw` 静态值 | 能源管理系统（EMS）或智能电表实时数据流 |
| `energy.by_line` | 硬编码三线 [128/82/83] kW | EMS 多线聚合 API |
| `energy.by_process` | 按 realtimeKw × 固定比例（加热45%/成型35%/冷却12%/辅助8%） | EMS 工序级能耗分解（需工序级电表） |
| `energy.peak` | `peakKw` 静态值，需量上限固定 250kW | EMS 峰值监测（配合需量电费策略） |
| `energy.cost` | `costToday` 静态值，基线固定 1820 元 | ERP 能耗成本模块（峰谷电价 + 需量电费） |
| `energy.efficiency` | `carbonKgPerUnit / 0.5` 派生 kWh/件 | MES 产量 + EMS 能耗 → 实时单耗 |
| `energy.carbon` | `carbonKgPerUnit` 静态值，目标 2.5 | 碳排放计算服务（区域电网排放因子 × 用电量） |
| `energy.anomaly` | realtimeKw > baselineKw × 1.15 判定 | EMS 异常检测（突增/突降/持续偏高，需时序算法） |
| `cost.summary` | `COST` 域汇总（OEE损失+能耗+质量损失） | ERP 综合损失成本报表（跨 MES/QMS/EMS 聚合） |

> `cost.summary` 虽注册在 energy.ts，但语义是跨域综合损失成本（OEE 损失折算 + 能耗成本 + 质量损失），生产替换需聚合 MES（产量损失）+ EMS（能耗）+ ERP（单价）三源。

### 1.6 排产域（`tools/domains/scheduling.ts`，共 8 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `schedule.current` | `SCHEDULE.attainment` 派生工单进度（订单号硬编码 PO-2026-0619-01） | MES 排产模块 / APS 工单 API |
| `schedule.attainment` | `SCHEDULE.attainment` 静态值，目标 0.95 | MES 排产达成率报表 |
| `schedule.changeover` | `changeoverMinutesToday` 静态值，基线 60min / SMED 目标 30min | MES 换模事件日志（含每次换模时长） |
| `schedule.bottleneck_resource` | `bottleneckResource` 静态字符串 | TOC 瓶颈分析服务（基于工序产能模型） |
| `schedule.capacity` | `capacityUtilization` 静态值 | APS 产能负荷计算（订单需求 ÷ 可用产能） |
| `schedule.ct_vs_takt` | `ctSeconds/taktSeconds` 静态值 | MES 节拍采集（CT）+ ERP 订单需求（Takt） |
| `schedule.queue` | 硬编码 3 条工单队列 | APS 工单池 + 优先级引擎 |
| `schedule.suggest` | 按 attainment<0.8 分支返回建议 | APS 排产优化引擎 + 调度员经验规则库 |

> **注意**：旧版文档将此域误写为 `production.*`，实际域前缀为 `schedule.*`。

### 1.7 物料域（`tools/domains/material.ts`，共 9 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `material.wip_level` | `MATERIAL.wipLevel/wipMax` 静态值 | MES 在制品追踪（RFID/条码扫描） |
| `material.inventory` | `inventoryHours` 静态值，阈值 24h | ERP WM 模块（库存量 / 消耗速率 → 可用小时） |
| `material.shortage` | `shortageRisk` 静态值 | ERP 缺料预警（安全库存 vs 在途 + 消耗速率） |
| `material.flow` | flowTime 按 wipLevel 二元判断（180min 或 95min） | VSM 实测（各工序时间 + 等待时间采集） |
| `material.kanban` | 看板流通/积压静态值 | MES 电子看板系统（拉动信号状态） |
| `material.supply_risk` | 按 shortageRisk>0.2 分支返回供应商风险 | SRM 供应商管理（历史准时率 + 在途订单） |
| `material.consumption_rate` | 硬编码 60 件/h（峰值 72 / 谷值 45） | MES 实时产量采集 → 消耗速率计算 |
| `material.suggest` | 按 inventory/wip 分支返回建议 | APS 物料需求计划（MRP） + 采购策略引擎 |
| `material.routing` | `ROUTING` 静态工序路线（距离/时间/等待/方式） | IE 标准工时表（季度更新）或 AGV/输送线 PLC 日志 |

### 1.8 人员域（`tools/domains/personnel.ts`，共 4 个工具）

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `personnel.skill_matrix` | `PERSONNEL.keyPositions[]` 静态人员表（L1-L4 技能等级） | HR 系统技能矩阵模块 / 培训管理系统（LMS） |
| `personnel.by_shift` | 按 A/B/C 班次过滤 keyPositions | HR 排班系统 + MES 考勤 |
| `personnel.attendance` | `ATTENDANCE` 按场景×班次（出勤率/加班/缺岗/请假） | HR 考勤系统 + 门禁（班次级粒度） |
| `personnel.fatigue` | `FATIGUE` 5 代理指标加权合成疲劳分 + 每小时错误率拐点 | HR 考勤 + MES 产量 + QMS 缺陷（疲劳评分合成服务） |

> 人员域是"班次差异诊断"的关键交叉分析点（某班次缺陷高 → 查该班次人员技能等级 + 疲劳分 + 考勤）。生产替换需对接 HR 系统的技能资质数据 + 考勤排班，并保持人员隐私合规（脱敏姓名）。疲劳数据**不建议上可穿戴设备**（隐私合规复杂、ROI 低），用"班次级 + 小时级"两层代理指标即可。

### 1.10 精益分析域（`tools/domains/lean.ts`，共 2 个工具）

**新增域**：跨域聚合分析，不引入新数据源，而是对已有 8 个域数据的"元分析"。

| Mock 工具 | 当前数据来源 | 生产替换目标 |
|-----------|------------|------------|
| `lean.waste_audit` | 交叉调用 oee/quality/material/schedule/equipment/cost/routing 各域 accessor | 同上（工具本身无需替换，数据源替换后自动反映） |
| `lean.dmaic` | 交叉调用 cost/quality/oee/causal_chain/schedule/equipment 组装五阶段路线图 | 同上（DMAIC 框架逻辑通用，数据源替换后自动适配） |

> 精益域工具的特殊性：它们是"元分析工具"而非"数据查询工具"。生产部署时**不需要替换工具本身**，只需确保其依赖的底层域数据源已替换为真实 API。`lean.waste_audit` 覆盖丰田七大浪费（过量生产/等待/运输/过度加工/库存/动作/缺陷）+ 第八浪费（未利用的智慧），`lean.dmaic` 输出 Define/Measure/Analyze/Improve/Control 五阶段改善路线图。

### 1.11 MCP 动作工具（`tools/domains/mcp-actions.ts`，共 12 个）

当前所有 `mcp.*` 动作工具均为 mock，执行后只写入 `actionStore` 内存。生产替换：

| MCP 工具 | 目标系统 | 风险 | 注意 |
|---------|--------|------|------|
| `mcp.mes.schedule_work_order` | MES 工单 API | write | 需工单号参数，影响排产 |
| `mcp.mes.changeover` | MES 换模调度 | write | 需停线窗口授权 |
| `mcp.mes.reallocate_capacity` | APS/MES | write | 影响多产线，需 HITL |
| `mcp.erp.purchase_request` | ERP MM 模块 | write | 采购申请审批流 |
| `mcp.erp.material_issue` | ERP WM 模块 | write | 库存扣减，不可撤销 |
| `mcp.qms.quarantine` | QMS | write | 批次隔离，影响出货 |
| `mcp.qms.rework_order` | QMS | write | 返工工单创建 |
| `mcp.qms.scrap_batch` | QMS | **destructive** | 批量报废，不可逆 |
| `mcp.eam.maintenance_order` | EAM | write | 维护工单，影响设备可用率 |
| `mcp.eam.spare_part_order` | ERP 备件 | write | 备件采购申请 |
| `mcp.eam.stop_line` | MES | **destructive** | 停线，需双重确认 |
| `mcp.process.adjust_parameters` | MES/SCADA | write | 实时写参数，需工艺工程师授权 |

所有 destructive 动作在 `buildNexusGovernance()` 中已配置需要 HITL 二次确认，生产部署时检查 `governance.ts` 的 `requireConfirmation` 配置是否完整。

**actionStore 副作用闭环**：当前 mock 已实现 action→read 闭环（如 `mcp.eam.stop_line` → `equipment.lineStopped=true` → `oee.realtime` 返回 availability=0）。生产替换时需保留此闭环语义：动作执行后，对应读取工具下次查询应反映新状态。

---

## 二、知识库（KB）替换指引

当前 KB vault 位于 `data/nexus-vault/`，为演示用 seed 内容（27 个 Markdown，约 1787 行）。由 `data/nexus-vault/install-vault.ts` 幂等安装到 `OBSIDIAN_VAULT_PATH`（缺省 `.nexus-vault`）。

### 2.1 现有 seed 目录结构

```
data/nexus-vault/
├── 01-现场状态/           # 现场基准数据（4 文件）
│   ├── 设备台账与关键备件.md
│   ├── OEE计算口径.md
│   ├── WIP水位阈值.md
│   └── 节拍与CT标准.md
├── 02-改善项目/           # 改善案例与课题（8 文件）
│   ├── 当前课题/
│   │   └── 当前改善课题.md
│   ├── A3报告库/          # 6 个完整 A3 案例
│   │   ├── Cpk不足致尺寸超差案例.md
│   │   ├── WIP堆积致物料流堵塞案例.md
│   │   ├── 主轴轴承异响案例.md
│   │   ├── 换模超时致可用率损失案例.md
│   │   ├── 缺料停线案例.md
│   │   └── 能耗飙升诊断案例.md
│   └── 改善基准数据/
│       └── OEE诊断标准流程.md
├── 03-精益知识/           # 方法论与模板（10 文件）
│   ├── 工具模板/          # 8 个精益工具模板
│   │   ├── 5Why模板.md
│   │   ├── 鱼骨图模板.md
│   │   ├── PFMEA模板.md
│   │   ├── SPC控制图模板.md
│   │   ├── SMED模板.md
│   │   ├── VSM模板.md
│   │   ├── 防错Poka-Yoke模板.md
│   │   └── 8D模板.md
│   ├── 案例库/
│   │   └── 设备致质量案例索引.md
│   └── 术语表/
│       └── 精益术语表.md
├── 04-人与组织/           # 人员与变革管理（3 文件）
│   ├── L01产线负责人与阻力.md
│   ├── L02产线人员与阻力.md
│   └── 培训与技能矩阵.md
└── 05-推理辅助/           # 判断约束（2 文件）
    ├── 约束条件模板.md
    └── PDCA阶段判定.md
```

### 2.2 生产填充要求

| 目录 | 当前内容 | 生产填充内容 | 推荐来源 |
|------|---------|------------|--------|
| `01-现场状态/` | L01/L02/L03 设备台账 + OEE 口径 + WIP 阈值 + 节拍标准 | 真实设备清单、真实 OEE 计算口径、真实 WIP 红黄线 | 企业文控系统 + 设备部 + 工艺部 |
| `02-改善项目/A3报告库/` | 6 个 mock A3 案例 | 过去 2 年所有已结案 8D/A3 报告 | QMS 历史报告库 |
| `02-改善项目/当前课题/` | mock 课题清单（L01 OEE 提升等） | 真实进行中的改善课题 | 精益改善部门 |
| `02-改善项目/改善基准数据/` | mock 诊断流程 | 企业标准化诊断流程文件 | 质量管理体系文件 |
| `03-精益知识/工具模板/` | 8 个通用方法论模板 | 保留通用模板 + 补充企业特定变体 | 精益/质量部门积累 |
| `03-精益知识/案例库/` | 按 5 类问题索引 | 扩充到按产品族 × 缺陷类型索引 | 历史案例结构化 |
| `03-精益知识/术语表/` | OEE/FPY/CT 等核心术语 | 企业内部术语 + 产品代号 + 产线编号规则 | 企业标准化文件 |
| `04-人与组织/` | L01/L02 人员与阻力记录 | 真实关键人员 + 变革阻力分析（**需脱敏**） | HR + 精益推进办 |
| `05-推理辅助/` | 约束条件 + PDCA 判定 | 企业安全红线 + 合规约束 | EHS + 质量体系 |

### 2.3 KB 集成方式

当前使用 `ObsidianProvider`（`src/tools/knowledge/obsidian-provider.ts`）读取本地 `.md` 文件。生产可替换为：

- **Confluence**：使用 `McpKnowledgeProvider` 对接 Confluence MCP server
- **SharePoint**：自定义 provider 调用 Microsoft Graph API
- **企业内网知识库**：实现 `IKnowledgeProvider` 接口（`src/tools/knowledge/provider.ts`），约 50 行代码

> **注意**：旧版文档写的 `vault/sop/quality/equipment/terminology/methods` 五个目录在代码库中不存在，已修正为上述真实的五类结构。

---

## 三、因果链（Causal Chain）替换指引

### 3.1 现状

当前 `CAUSAL_CHAIN` 定义在 `tools/mock-data/scenarios.ts`，按 `场景 × 产线` 矩阵组织，实际覆盖 **4 组完整因果链**（非旧版文档所述"仅 anomaly+L01"）：

| 场景 | L01 | L02 | L03 |
|------|-----|-----|-----|
| normal | 空（无问题） | 空 | 空 |
| anomaly | ✅ **完整**：尺寸超差率 5.8% → 主轴跳动 → 轴承磨损 → 润滑不足 → **润滑泵滤网堵塞** | ✅ **完整**：尺寸超差率 2.5% → 温度漂移 → PID 未随模具老化调整 → **模具寿命校准机制缺失** | 空 |
| crisis | ✅ **完整（2 条并行链，同根因）**：① 轴承断裂停机 ② 能耗飙升 → 均指向 **预测性维护体系缺失** | ✅ **完整**：缺料停机 180min → 库存 12h < 安全线 → 采购未提前 → **安全库存公式缺交期波动参数** | 空 |

每组包含：
- `chains[]`：5Why 因果链（crisis+L01 有 2 条并行链）
- `fishbone`：5M1E 六分支（Machine/Method/Man/Material/Measurement/Environment），每分支带证据引用（指向具体 mock 字段，如"主轴健康分 0.62（见 EQUIPMENT.L01.healthScore）"）

### 3.2 生产积累要求

因果链是最高价值的知识资产，建议按以下优先级积累：

**第一阶段（上线即准备）**：
- 收集过去 2 年所有已结案的 8D / A3 报告，提取"根本原因 → 机制路径"
- 按产品族 × 缺陷类型建立基础因果链库（目标：每条产线 10+ 条高频根因链）
- 与 `02-改善项目/A3报告库/` 的历史案例建立双向索引

**第二阶段（持续运营）**：
- 每次 5Why 分析完成后，由工艺工程师录入因果链（表单化录入 → 自动生成结构）
- 建议字段：`rootCause`、`layers[5Why层级]`、`fishbone`、`线别`、`产品族`、`发生日期`、`验证状态`

**第三阶段（智能化）**：
- 基于历史案例训练分类模型，自动推荐最相近因果链
- 与 `quality.five_why` / `quality.fishbone` 工具联动，实现"症状 → 自动匹配历史根因"

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
    machine:  ["[设备相关因素，附证据引用]"],
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

当前硬编码：MTBF 基线 450h、MTTR 基线 45min、健康分计算方式、故障风险模型。

生产替换：
- MTBF/MTTR：从 EAM 停机记录实时计算（滚动 90 天）
- 健康分：IoT + PHM 服务实时输出（0-1 归一化，融合振动/温度/电流/油液）
- 故障风险：ML 模型预测服务（基于振动/温度/电流特征历史训练）

### 4.2 质量基线（`QUALITY` 常量）

当前硬编码：不良率目标 0.3%（阈值 3%）、Cpk 基线 1.33、USL/LSL 硬编码 10.2/9.8、主要缺陷类型固定。

生产替换：
- 目标值：从 QMS 产品规格 / 客户协议中读取
- 实测值：SPC 系统实时数据
- 缺陷类型权重：QMS 历史统计（动态帕累托）
- 规格上下限：按产品 + 尺寸动态从 PLM 读取

### 4.3 工艺标准（`PROCESS` 常量）

当前硬编码：温度标准 185°C、压力标准 4.2MPa、速度标准 1200rpm、公差固定 ±5%。

生产替换：
- 工艺标准窗口（上/下限）：PLM 工艺配方模块（按产品 + 模具 + 材料组合）
- 实测值：MES/SCADA 实时采集（每 5 秒或每模次）
- 偏差阈值：PLM 控制计划中的 `reactionPlan` 触发条件

### 4.4 产线配置（`LINE_CONFIG` / `LINES` 常量）

当前硬编码：L01 注塑线 / L02 装配线 / L03 精加工线三条产线。

生产替换：
- 从 ERP/MES 动态读取产线主数据（线别码、设备清单、产品族映射）
- 支持动态注册新产线，无需修改代码

### 4.5 班次偏移（`SHIFT_DEVIATION` 常量）

当前硬编码：A/B/C 三班次的 OEE/缺陷率/换模时间偏移量。

生产替换：
- MES 班次报表实时统计（按班次聚合 OEE/质量/换模）

### 4.6 成本参数（`COST` 常量）

当前硬编码：`outputLossUnits` / `oeeLossCost` / `energyCost` / `qualityLossCost` 均为静态值，单价隐含在计算中。

生产替换：
- OEE 损失成本 = 产量损失 × 产品单价（ERP）
- 能耗成本 = 用电量 × 峰谷电价（EMS + ERP）
- 质量损失 = 报废量 × 材料成本 + 返工工时 × 人工费率（QMS + HR）

### 4.7 人员数据（`PERSONNEL` 常量）

当前硬编码：各产线关键岗位人员表（姓名 + 班次 + 技能等级 L1-L4）。

生产替换：
- HR 系统技能矩阵 + 培训记录
- MES 考勤排班
- **合规要求**：人员姓名需脱敏，仅保留工号 + 技能等级

---

## 五、数据充分性补充（每工具 Mock 局限性）

本章针对每个工具的 mock 数据局限性做详细说明，帮助评估"上线后输出质量会下降多少"。

### 5.1 时序类工具（历史数据维度不足）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `oee.history` | 只有 7 个插值点，非真实时序 | 至少 90 天连续时序（每班次一个点） |
| `oee.trend` | 环比只有"上周 vs 本周"两点 | 需支持自定义时间窗（周/月/季） |
| `energy.realtime` | 单点快照 | 需秒级实时流（至少 1min 粒度） |
| `equipment.failure_predict` | 固定概率值 | 需传感器历史 90+ 天训练 ML 模型 |

### 5.2 派生类工具（计算逻辑过于简化）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `oee.availability_loss` | planned/unplanned/changeover 按固定比例拆 | 需按真实停机事件类型分类汇总 |
| `oee.performance_loss` | minorStops/speedLoss/idling 固定比例 | 需小停机事件流 + 速率监控 |
| `oee.quality_loss` | scrap/rework/downgrade 固定 60/30/10 | 需按 QMS 处置类型真实统计 |
| `material.flow` | flowTime 二元判断（180 或 95 分钟） | 需各工序实测时间（VSM 采集） |
| `material.consumption_rate` | 固定 60 件/h | 需 MES 实时产量采集 |

### 5.3 伪信号类工具（数据为派生而非实测）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `equipment.health` | `signals.vibration/temp/current` 从 healthScore 偏移派生 | 需独立 IoT 传感器分通道数据 |
| `quality.spc` | 30 样本 + 多尺寸（已满足 25+ 标准），Nelson 规则 | 可直接使用；生产需 SPC 系统实时采集连续样本 |
| `quality.cp_cpk` | USL/LSL 硬编码 | 需按产品规格动态读取 |
| `energy.by_process` | 按 realtimeKw 固定比例分解 | 需工序级独立电表 |

### 5.4 静态清单类工具（无动态更新）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `equipment.downtime` | 静态事件列表 | 需 MES 停机事件实时流 |
| `equipment.maintenance_log` | 按 healthScore 二分支 | 需 EAM 工单历史 |
| `equipment.alarm_history` | 按 healthScore 二分支 | 需报警事件流 + 故障码字典 |
| `equipment.spare_parts` | 按 healthScore 二分支 | 需 ERP 备件库存实时查询 |
| `quality.pareto` | 静态缺陷排序 | 需 QMS 缺陷动态统计 |
| `quality.inspection` | 静态首检/巡检记录 | 需 QMS 检验计划 + 记录 |
| `schedule.queue` | 硬编码 3 条工单 | 需 APS 工单池 |
| `material.supply_risk` | 按 shortageRisk 二分支 | 需 SRM 供应商数据 |

### 5.5 因果推理类工具（依赖知识积累）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `quality.five_why` | 仅 4 组预置链 | 需历史案例库（目标 ≥10 条/产线） |
| `quality.fishbone` | 同上 | 同上 |
| `quality.root_cause_5m1e` | 按 cpk 二分支布尔标签 | 需专家系统 / FMEA 知识库 |
| `process.quality_impact` | 硬编码注塑规则 | 需扩充到企业特定产品 PFMEA |
| `process.fmea` | 从 PROCESS 派生 | 需 PLM PFMEA 模块完整数据 |

### 5.6 人员类工具（合规风险）

| 工具 | Mock 局限 | 生产需补充 |
|------|----------|----------|
| `personnel.skill_matrix` | 静态人员表（含真实姓名） | HR 系统数据，**姓名需脱敏为工号** |
| `personnel.by_shift` | 静态班次配置 | HR 排班 + MES 考勤，**注意数据隐私合规** |

---

## 六、数据替代优先级路线图

```
第一优先（影响核心诊断准确性）：
  ✦ process.parameters → SCADA 实时采集
  ✦ quality.five_why → 真实因果链库（历史 8D/A3）
  ✦ equipment.health → IoT + PHM 服务（分通道传感器）
  ✦ oee.realtime → MES OEE API
  ✦ quality.spc → SPC 系统多尺寸实时数据

第二优先（影响建议可执行性）：
  ✦ 所有 mcp.* 动作工具 → 真实系统写入 API
  ✦ KB vault → 企业 Confluence/SharePoint
  ✦ quality.defect_rate → QMS 实时缺陷
  ✦ equipment.downtime → MES 停机事件流
  ✦ material.inventory → ERP WM 实时库存

第三优先（影响分析深度）：
  ✦ equipment.failure_predict → ML 预测服务
  ✦ energy.* → EMS（含工序级分解）
  ✦ schedule.* → APS（含优化引擎）
  ✦ process.quality_impact 规则库 → PLM PFMEA 条目
  ✦ personnel.* → HR 系统（注意脱敏）

持续积累（知识资产）：
  ✦ 因果链库：每完成一次 5Why 分析即录入（目标 ≥10 条/产线）
  ✦ A3 报告库：每季度批量导入已结案案例
  ✦ 术语表：随企业标准更新同步
  ✦ SPC 控制图：随产品切换动态加载规格
```

---

## 七、部署检查清单

上线前确认：

**数据源接入**
- [ ] `NEXUS_MCP_SERVERS` 环境变量配置了真实 MCP server 地址
- [ ] `OBSIDIAN_VAULT_PATH` 指向企业 KB 路径（或已换成 Confluence provider）
- [ ] MES API 已对接（OEE/停机/工艺参数/排产）
- [ ] EAM API 已对接（设备状态/维护工单/备件）
- [ ] QMS API 已对接（缺陷/检验/隔离/返工）
- [ ] ERP API 已对接（库存/采购/成本）
- [ ] EMS API 已对接（实时能耗/峰值/成本）
- [ ] HR API 已对接（技能矩阵/排班）——**注意人员数据脱敏**

**治理与安全**
- [ ] `governance.ts` 中所有 destructive 动作均配置了 `requireConfirmation: true`
- [ ] `preconditions.ts` 中前置条件检查逻辑与真实数据结构对齐
- [ ] LLM 密钥已配置生产密钥（`ANTHROPIC_API_KEY` 或企业 LLM 网关）
- [ ] 人员姓名字段已脱敏（工号替代）
- [ ] 不在日志中打印敏感信息（人员/批次/客户）

**数据充分性**
- [ ] 因果链库已有 ≥10 条历史根因（否则 `quality.five_why` 对真实问题输出空结果）
- [ ] SPC 系统已配置产品关键尺寸 + 规格（否则 `quality.spc` 无法多尺寸支持）
- [ ] IoT 传感器已部署分通道采集（否则 `equipment.health` 仍是伪信号）
- [ ] 工序级电表已部署（否则 `energy.by_process` 仍是固定比例）

**工具替换验证**
- [ ] 所有 mock `getData` 函数已替换为真实 API 调用（逐工具检查 `tool-factory.ts` 注册）
- [ ] actionStore 副作用闭环语义保留（动作执行后读取工具反映新状态）
- [ ] MCP 动作工具已完成集成测试（在 staging 环境验证 HITL 流程）
- [ ] `oee.report_html` 生成的 HTML 中 `postMessage` 动作按钮指向正确的 MCP 工具名
- [ ] 9 个工具域 × 全部 89 个工具均已逐个验证数据源替换（含 lean 域 2 个元分析工具 + 12 个 MCP 动作工具）

---

*本文档随实现迭代更新，以 `apps/nexusops/tools/mock-data/scenarios.ts` 和 `apps/nexusops/tools/domains/*.ts` 中的实际代码为唯一参考基准。*

**本次扩展记录**：新增 `material.routing`、`personnel.attendance`/`personnel.fatigue`、`quality.sigma_level`/`quality.dpmo`、`lean.waste_audit`/`lean.dmaic`（精益域），升级 `quality.spc` 为 30 样本 + Nelson 规则。工具域从 8 → 9（新增 lean 域），`buildNexusTools()` 返回的工具从 70 → 77（净增 7 个域工具 + 2 个 lean 元分析工具），含 MCP 动作工具系统总计 89 个。
