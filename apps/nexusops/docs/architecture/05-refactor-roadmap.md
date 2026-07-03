# 05 - 重构路线图

**职责**：把前 5 份设计文档转化为可执行的分阶段计划。每个 Phase 独立可交付，前序 Phase 不阻塞后续 Phase 的准备工作。

**核心原则**：渐进式、不阻塞业务、每一阶段都有完整测试覆盖。

---

## Phase 0：抽象接口 + MockOrchestrator

**目标**：建立 Orchestrator / ToolResolver / ReportComponents 三套接口，把现有硬编码逻辑封装到 Mock 实现。**不改变现有运行行为**（skill 仍正常工作），只是把知识抽到接口后，为后续替换做准备。

**relos 依赖**：无

### 0.1 任务清单

| # | 任务 | 产出文件 | 依赖 |
|---|---|---|---|
| 0.1 | 定义 `Orchestrator` 接口 + 数据结构 | `src/orchestrator/types.ts`（新增） | — |
| 0.2 | 定义 `ToolResolver` 接口 | `src/orchestrator/tool-resolver.ts`（新增） | 0.1 |
| 0.3 | 定义 `ReportComponent` / `ComponentLayout` 类型 | `src/orchestrator/report-types.ts`（新增） | — |
| 0.4 | 扩展 `FlowConnector` 加 `semanticTags?` 字段 | `src/tools/base.ts`（修改） | — |
| 0.5 | 实现 `MockOrchestrator`（读 JSON 规则） | `src/orchestrator/mock-orchestrator.ts`（新增） | 0.1 |
| 0.6 | 实现 `IndexToolResolver`（读本地索引） | `src/orchestrator/index-resolver.ts`（新增） | 0.2 |
| 0.7 | 实现 `LlmToolResolver`（LLM 兜底解析） | `src/orchestrator/llm-resolver.ts`（新增） | 0.2 |
| 0.8 | 生成 mock 规则数据（见 04-mock-rules-spec.md §8） | `data/relos-mock/*.json`（新增） | 0.5 |
| 0.9 | 扩展 `SkillRegistry` 加 `reportTemplates` 表 | `src/agent/skill-registry.ts`（修改） | 0.3 |
| 0.10 | 给现有 40+ 工具标注 `semanticTags` | `apps/nexusops/tools/**/*.ts`（修改） | 0.4 |

### 0.2 受影响文件

**新增文件**（`src/orchestrator/` 目录）：
- `types.ts`（Orchestrator / Methodology / EvidenceContract / CausalChain 等类型）
- `tool-resolver.ts`（ToolResolver 接口 + ResolvedTool）
- `report-types.ts`（ReportComponent / ComponentLayout）
- `mock-orchestrator.ts`（MockOrchestrator 实现）
- `index-resolver.ts`（IndexToolResolver）
- `llm-resolver.ts`（LlmToolResolver）

**修改文件**：
- `src/tools/base.ts`（FlowConnector 加 semanticTags）
- `src/agent/skill-registry.ts`（加 reportTemplates 表 + 方法）
- `apps/nexusops/tools/**/*.ts`（40+ 工具加 semanticTags）

**新增数据**：
- `data/relos-mock/relations.json`
- `data/relos-mock/methodologies-full.json`
- `data/relos-mock/methodologies-min.json`
- `data/relos-mock/evidence-contracts.json`

### 0.3 测试策略

```typescript
// tests/unit/orchestrator/test-mock-orchestrator.ts
describe("MockOrchestrator", () => {
  it("getMethodology('dmaic') 返回完整结构化方法论", async () => {
    const orch = new MockOrchestrator("data/relos-mock/");
    const m = await orch.getMethodology("dmaic", {});
    expect(m?.granularity).toBe("full");
    expect(m?.phases).toHaveLength(5);
    expect(m?.source).toBe("mock");
  });

  it("getCausalChain 按 scenario+line 过滤", async () => {
    const orch = new MockOrchestrator("data/relos-mock/");
    const chain = await orch.getCausalChain("", { scenarioId: "anomaly", line: "L01" });
    expect(chain?.chains[0]?.rootCause).toContain("润滑泵滤网堵塞");
  });

  it("normal 场景返回空因果链", async () => {
    const orch = new MockOrchestrator("data/relos-mock/");
    const chain = await orch.getCausalChain("", { scenarioId: "normal", line: "L01" });
    expect(chain?.chains).toHaveLength(0);
  });
});

// tests/unit/orchestrator/test-tool-resolver.ts
describe("IndexToolResolver", () => {
  it("按 semantic 查到工具", async () => {
    const resolver = new IndexToolResolver("data/relos-mock/tool-index.json");
    const r = await resolver.resolve({ semantic: "process_capability", required: true }, {});
    expect(r?.toolName).toBe("quality.cp_cpk");
    expect(r?.source).toBe("index");
  });

  it("未命中的 semantic 返回 null", async () => {
    const resolver = new IndexToolResolver("data/relos-mock/tool-index.json");
    const r = await resolver.resolve({ semantic: "nonexistent_semantic", required: true }, {});
    expect(r).toBeNull();
  });
});
```

### 0.4 风险与回滚

| 风险 | 缓解 |
|---|---|
| `semanticTags` 字段引入导致现有工具类型不兼容 | `semanticTags?` 设为可选，未标注的工具正常工作 |
| mock 规则数据错误（翻译 CAUSAL_CHAIN 时遗漏） | Phase 0 不接入主流程，只做单元测试；数据错误不影响生产 |
| `FlowConnector` 修改影响面广 | 只新增字段，不改现有字段；现有代码零改动 |

**回滚**：Phase 0 全部是新增文件 + 可选字段，删除新文件即回滚，不影响现有功能。

### 0.5 验收标准

- [ ] `MockOrchestrator` 单元测试全过（覆盖 9 场景 + 8 方法论）
- [ ] `IndexToolResolver` 单元测试全过
- [ ] 现有 172 个 NexusOps 测试无回归
- [ ] mock 规则数据完整性校验通过（见 04-mock-rules-spec.md §9）

---

## Phase 1：报表组件化

**目标**：把 `report-html.ts` 的模板拆成组件库，建立 LLM 编排协议。现有 OEE/DMAIC 报告改用组件渲染。

**relos 依赖**：无

### 1.1 任务清单

| # | 任务 | 产出文件 |
|---|---|---|
| 1.1 | 提取 `SHARED_CSS` 到 `REPORT_CSS` | `apps/nexusops/skills/report-components.ts`（新增） |
| 1.2 | 实现 13 个初始组件（kpi-card / trend-svg / evidence-table 等） | 同上 |
| 1.3 | 实现 `ReportRenderer`（消费 ComponentLayout） | `apps/nexusops/skills/report-renderer.ts`（新增） |
| 1.4 | 重构 `buildOeeBodyHtml` 为组件调用序列 | `apps/nexusops/skills/report-html.ts`（修改） |
| 1.5 | 重构 `buildDmaicBodyHtml` 为组件调用序列 | 同上 |
| 1.6 | 实现 `getComponentManifest`（给 LLM 的组件说明书） | `report-components.ts` |
| 1.7 | 实现 LLM 编排 prompt 模板 | `report-html.ts` |

### 1.2 受影响文件

**新增**：
- `apps/nexusops/skills/report-components.ts`
- `apps/nexusops/skills/report-renderer.ts`
- `apps/nexusops/skills/report-utils.ts`（escapeHtml 等工具函数）

**修改**：
- `apps/nexusops/skills/report-html.ts`（重构 steps，但保持对外接口）

### 1.3 测试策略

```typescript
// 关键测试：组件渲染契约
describe("ReportComponents", () => {
  it("kpi-card 渲染正确 HTML", () => {
    const html = kpiCard.render({ label: "OEE", value: "61%", target: "目标 85%" });
    expect(html).toContain("kpi-card");
    expect(html).toContain("OEE");
    expect(html).toContain("61%");
  });
});

// 关键测试：渲染器端到端
describe("ReportRenderer", () => {
  it("ComponentLayout → 完整 HTML", () => {
    const layout: ComponentLayout = {
      reportType: "test", title: "测试",
      components: [{ name: "kpi-card", data: { label: "OEE", value: "61%" } }]
    };
    const html = renderReport(layout);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("kpi-card");
  });
});

// 回归测试：现有 report-html 测试保持不变
// test-nexus-kb-skills.ts 里的 report_html 契约测试全过
```

### 1.4 风险与回滚

| 风险 | 缓解 |
|---|---|
| 重构 report-html.ts 破坏现有测试契约 | 保持 `_isHtmlReport` / `<!DOCTYPE html>` / 标题断言不变 |
| 组件样式与原模板不一致 | 视觉回归测试（截图对比） |

**回滚**：report-html.ts 用 git 回滚到重构前版本。

---

## Phase 2：报表固化闭环

**目标**：实现右栏"固化"按钮，支持人工把 LLM 编排的 layout 固化为 JSON 模板，下次同主题复用。

**relos 依赖**：无

### 2.1 任务清单

| # | 任务 | 产出文件 |
|---|---|---|
| 2.1 | 实现 `SkillRegistry.registerReportTemplate` / `getReportTemplate` | `src/agent/skill-registry.ts`（修改） |
| 2.2 | 实现后端 API `POST /api/report-templates` | `apps/nexusops/server/api-report-templates.ts`（新增） |
| 2.3 | 前端 `HtmlReportFrame` 加"固化"按钮 + 编辑器弹窗 | `apps/nexusops/web/src/components/ArtifactSlot.tsx`（修改） |
| 2.4 | 前端固化编辑器组件 | `apps/nexusops/web/src/components/ReportSolidifyEditor.tsx`（新增） |
| 2.5 | `parseHtmlReportOutput` 透传 ComponentLayout 到前端 | `apps/nexusops/web/src/lib/artifacts.ts`（修改） |
| 2.6 | 报表生成入口：先查模板，未命中走 LLM 编排 | `apps/nexusops/skills/report-html.ts`（修改） |

### 2.2 测试策略

```typescript
// SkillRegistry 固化测试
describe("SkillRegistry reportTemplates", () => {
  it("登记 + 查询 active 模板", () => {
    const reg = new SkillRegistry(tmpPath);
    reg.registerReportTemplate({ reportType: "dmaic", title: "DMAIC", layout: {...}, status: "active", source: "manual" });
    const t = reg.getReportTemplate("dmaic");
    expect(t?.status).toBe("active");
  });
});

// E2E：固化 → 复用
describe("固化闭环 E2E", () => {
  it("固化后下次同主题走模板路径", async () => {
    // 1. 首次生成（LLM 编排）
    const report1 = await generateReport("dmaic", evidenceData);
    // 2. 固化
    await registry.registerReportTemplate({ reportType: "dmaic", layout: report1.layout, status: "active", source: "manual" });
    // 3. 二次生成（走模板）
    const report2 = await generateReport("dmaic", newEvidenceData);
    expect(report2.usedTemplate).toBe(true);
  });
});
```

---

## Phase 3：接入 relos

**目标**：实现 `RelosOrchestrator`，boot 时加载缓存，后台定时刷新，支持 `syncToolIndex` 回写。

**relos 依赖**：relos 服务可用（`GET /health` 返回 ok）

### 3.1 任务清单

| # | 任务 | 产出文件 |
|---|---|---|
| 3.1 | 实现 `RelosOrchestrator`（HTTP 调 relos API） | `src/orchestrator/relos-orchestrator.ts`（新增） |
| 3.2 | 实现 `CacheLayer`（本地缓存 + 过期判定） | `src/orchestrator/cache-layer.ts`（新增） |
| 3.3 | 实现 `FallbackChain`（降级链组装） | `src/orchestrator/fallback-chain.ts`（新增） |
| 3.4 | boot.ts 组装 FallbackChain（CacheLayer → RelosOrchestrator → MockOrchestrator） | `apps/nexusops/server/boot.ts`（修改） |
| 3.5 | 实现后台定时刷新（scheduleBackgroundRefresh） | 同上 |
| 3.6 | 实现 `syncToolIndex` 定期回写 | 同上 |

### 3.2 测试策略

```typescript
// RelosOrchestrator 集成测试（需 relos 可用）
describe("RelosOrchestrator (integration)", () => {
  it("getMethodology 从 relos 获取", async () => {
    const orch = new RelosOrchestrator("http://localhost:8000");
    const m = await orch.getMethodology("dmaic", {});
    expect(m?.source).toBe("relos");
  });
});

// FallbackChain 降级测试（mock relos 不可达）
describe("FallbackChain 降级", () => {
  it("relos 不可达 → 降级到 MockOrchestrator", async () => {
    const chain = new FallbackChain([
      new CacheLayer("empty-cache/"),  // 缓存空
      new FailingRelosOrchestrator(),  // 模拟 relos 挂
      new MockOrchestrator("data/relos-mock/"),
    ]);
    const m = await chain.getMethodology("dmaic", {});
    expect(m?.source).toBe("mock");
  });

  it("缓存过期但有数据 → 返回 cache_stale", async () => {
    const chain = new FallbackChain([
      new CacheLayer("stale-cache/"),  // 过期缓存
      new FailingRelosOrchestrator(),
    ]);
    const m = await chain.getMethodology("dmaic", {});
    expect(m?.source).toBe("cache_stale");
  });
});
```

### 3.3 风险

| 风险 | 缓解 |
|---|---|
| relos 服务不稳定 | FallbackChain 降级到 MockOrchestrator |
| 缓存格式与 relos 返回格式不一致 | CacheLayer 严格按 relos ContextBlock schema 存储 |
| 网络延迟拖慢 boot | 缓存同步加载，relos 异步刷新 |

---

## Phase 4：skill 退化 + LLM 主导

**目标**：主路径切换到 Orchestrator + LLM 编排，skill 退化为兜底。dmaic.ts 等保留但不被主流程优先调用。

**relos 依赖**：Phase 3 完成，relos 稳定运行

### 4.1 任务清单

| # | 任务 | 产出文件 |
|---|---|---|
| 4.1 | `prepare-step` 注入 Orchestrator 方法论指导 | `src/agent/prepare-step.ts`（修改） |
| 4.2 | `prepare-step` 实现 blocking 点 EvidenceContract 校验 | 同上 |
| 4.3 | 把 ToolResolver 能力暴露给 LLM（注册 `tool_resolver` 工具） | `apps/nexusops/tools/tool-resolver-tool.ts`（新增） |
| 4.4 | skill 标注 `fallback: true`（标识为兜底，非主路径） | `apps/nexusops/skills/**/*.ts`（修改） |
| 4.5 | 更新 `NEXUS_SYSTEM_PROMPT`（引导 LLM 用 Orchestrator + ToolResolver） | `apps/nexusops/server/boot.ts`（修改） |
| 4.6 | 报表生成接入 LLM 编排（Phase 1 的协议启用） | `apps/nexusops/skills/report-html.ts`（修改） |

### 4.2 验收标准（端到端）

```
用户问："分析 L01 的 6Sigma 水平"
  ↓
LLM 识别意图 → 调 orchestrator.get_methodology("dmaic")
  ↓ 得到 {phases: D/M/A/I/C, source: "relos", confidence: 0.95}
LLM 进 D 阶段 → toolResolver.resolve({semantic:"oee"}) → quality.cp_cpk
  ↓ 自主调用，不被 skill.dmaic 硬编码序列拽着走
... 完成五阶段 ...
  ↓
LLM 生成报告 → 报表系统组件化渲染（非 HTML 字符串）
  ↓
报告主题与 DMAIC 一致（不再漂移到 OEE 根因报告）
```

### 4.3 风险

| 风险 | 缓解 |
|---|---|
| LLM 编排不稳定（每次结果不同） | 成熟方法论用 full 粒度（强约束）；EvidenceContract 把关 blocking 点 |
| skill 退化导致现有测试失效 | skill 保留，测试仍调 skill；新增 LLM 编排的 E2E 测试 |
| Orchestrator 查询性能 | 会话内缓存（同 topic 不重复查） |

---

## 里程碑总览

| 里程碑 | 内容 | 预估工时 | 前置条件 |
|---|---|---|---|
| **M0**（Phase 0） | 抽象接口 + MockOrchestrator + 数据 | ~3-4 天 | 无 |
| **M1**（Phase 1） | 报表组件化 | ~2-3 天 | M0 |
| **M2**（Phase 2） | 报表固化闭环 | ~2-3 天 | M1 |
| **M3**（Phase 3） | 接入 relos | ~3-4 天 | relos 可用 |
| **M4**（Phase 4） | skill 退化 + LLM 主导 | ~3-5 天 | M3 |

**总计**：约 13-19 个工作日。

**可并行项**：Phase 1 和 Phase 2 可与 Phase 3 并行（Phase 3 等 relos 就绪期间，前端/报表工作可推进）。

---

## 关键依赖图

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──────────────→ Phase 4
   │                                         ↑
   └──→ Phase 3（relos 可用时启动）──────────┘
```

- Phase 0 是所有后续的基础
- Phase 1-2 不依赖 relos，可与 Phase 3 并行
- Phase 4 依赖 Phase 3（需要 Orchestrator 在线）+ Phase 1（需要组件化报表）

---

## 附录 A：跨 Phase 的全局测试矩阵

| 测试类型 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|---|
| 单元测试（MockOrchestrator） | ✅ 新增 | 维护 | 维护 | 维护 | 维护 |
| 单元测试（ReportComponents） | — | ✅ 新增 | 维护 | 维护 | 维护 |
| 单元测试（SkillRegistry） | ✅ 扩展 | — | ✅ 扩展 | 维护 | 维护 |
| 集成测试（FallbackChain） | — | — | — | ✅ 新增 | 维护 |
| E2E（固化闭环） | — | — | ✅ 新增 | 维护 | 维护 |
| 回归测试（现有 172 测试） | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过 |
| E2E（LLM 主导分析） | — | — | — | — | ✅ 新增 |

---

## 附录 B：决策追溯表

每个设计决策的出处，便于未来回溯"为什么这样设计"：

| 决策 | 出处 | 文档定位 |
|---|---|---|
| D1 relos 形态=关系图谱+置信度 | 用户确认 | 00 §2 |
| D2 boot 缓存+后台更新 | 用户确认 | 00 §2；01 §4 |
| D3 relos 通用不懂工具 | 用户确认 | 00 §2；02 §1 |
| D4 企业可回写工具索引 | 用户确认 | 00 §2；02 §4 |
| D5 LLM 主导执行 | 用户确认 | 00 §2；01 §5 |
| D6 缓存失效用过期缓存 | 用户确认 | 00 §2；01 §4 |
| D7 LLM 输出组件序列 JSON | 用户确认 | 00 §2；03 全文 |
| D8 固化=JSON 配置 | 用户确认 | 00 §2；03 §7 |
| D9 固化入口在右栏 | 用户确认 | 00 §2；03 §7.3 |
| D10 语义标注在工具侧 | 用户确认 | 00 §2；02 §2 |
| D11 方法论 C 混合粒度 | 用户确认 | 00 §2；01 §2.3；04 §4 |
