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

## Phase M：Mestar MCP 接入（catalog 模式，横切 Phase）

**目标**：接入"目录驱动型"MCP server（首个实例 mestar-mcp-server，8 元工具 + 2850 catalog 候选），让数千工具按需定位而非全量灌入 LLM。

**relos 依赖**：无（与 relos 正交：relos 提供"该用什么方法论/需要什么语义数据"，mestar 提供"该语义数据用哪个具体工具获取"）

**完整规范**：详见 [07-mestar-integration-spec.md](07-mestar-integration-spec.md)

### M.1 任务清单

| # | 任务 | 产出文件 | 状态 |
|---|---|---|---|
| M0.1 | 写 07-mestar-integration-spec.md 接入规范文档（含 mermaid 时序图 + 决策追溯表） | `apps/nexusops/docs/architecture/07-mestar-integration-spec.md`（新增） | ✅ |
| M0.2 | 扩展 McpServerConfig 加 `catalog?` 可选字段（向后兼容） | `src/tools/mcp/mcp-client.ts`（修改） | ✅ |
| M0.3 | .env.example 补充 mestar catalog 配置示例 | `.env.example`（修改） | ✅ |
| M1.1 | 实现 McpCatalogCache（分页拉取 + 规则派生 + 分桶持久化 + 在线回写） | `src/tools/mcp/mcp-catalog-cache.ts`（新增） | ✅ |
| M1.2 | boot.ts MCP 装配块改造（catalog 模式走预热而非全量注册） | `apps/nexusops/server/boot.ts`（修改） | ✅ |
| M1.3 | McpCatalogCache 单元测试（mock catalog.search） | `tests/unit/tools/test-mcp-catalog-cache.ts`（新增，10 用例） | ✅ |
| M2.1 | 确认 Embedding 实现方案（ai SDK 内置 embedMany + cosineSimilarity，零新依赖） | — | ✅ |
| M2.2 | 实现 EmbeddingToolRouter（向量构建 + top-K 检索 + 持久化） | `src/orchestrator/embedding-router.ts`（新增） | ✅ |
| M2.3 | 改造 LlmToolResolver 支持域内小集合选择（candidateProvider） | `src/orchestrator/llm-resolver.ts`（修改） | ✅ |
| M2.4 | resolver-factory 装配 EmbeddingRouter（Index→Embedding→LLM 链） | `src/orchestrator/resolver-factory.ts`（修改） | ✅ |
| M2.5 | EmbeddingRouter 单元测试 + 降级测试 | `tests/unit/orchestrator/test-embedding-router.ts`（新增，8 用例） | ✅ |
| M3.1 | 实现 CatalogSearchResolver（在线兜底 + 回写本地索引） | `src/orchestrator/catalog-search-resolver.ts`（新增） | ✅ |
| M3.2 | 实现 LazyMcpActionTool（按需激活 FlowConnector） | `src/tools/mcp/lazy-mcp-action-tool.ts`（新增） | ✅ |
| M3.3 | boot.ts systemPrompt 注入模块目录地图 | `apps/nexusops/server/boot.ts`（修改） | ✅ |
| M3.4 | E2E 测试（查设备BOM 全链路：预热→解析→lazy 调用→EvidenceEnvelope） | `tests/unit/tools/test-mestar-e2e.ts`（新增，4 用例） | ✅ |

### M.2 受影响文件

**新增文件**（4 个源文件 + 3 个测试 + 1 个文档）：
- `src/tools/mcp/mcp-catalog-cache.ts`（McpCatalogCache 预热层）
- `src/orchestrator/embedding-router.ts`（EmbeddingToolRouter 向量路由）
- `src/orchestrator/catalog-search-resolver.ts`（CatalogSearchResolver 在线兜底）
- `src/tools/mcp/lazy-mcp-action-tool.ts`（LazyMcpActionTool 按需激活）
- `apps/nexusops/docs/architecture/07-mestar-integration-spec.md`（接入规范）

**修改文件**（5 个）：
- `src/tools/mcp/mcp-client.ts`（McpServerConfig 加 catalog 字段）
- `src/orchestrator/llm-resolver.ts`（加 candidateProvider 域内选择）
- `src/orchestrator/resolver-factory.ts`（装配链扩展）
- `src/services/llm-service.ts`（加 embeddingModel() 复用 OpenAI provider）
- `apps/nexusops/server/boot.ts`（catalog 装配分流 + EmbeddingRouter 注入 + systemPrompt 模块地图）

### M.3 测试覆盖

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `test-mcp-catalog-cache.ts` | 10 | 分页拉取、规则派生、分桶持久化、executable=false 不进索引、mestar 不可达降级 |
| `test-embedding-router.ts` | 8 | 向量构建、retrieve top-K、resolve 高/低相似度、loadIndex 持久化、Embedder 失败降级 |
| `test-mestar-e2e.ts` | 4 | 预热→解析命中→lazy 调用→EvidenceEnvelope 全链路；在线兜底回写；执行失败不崩溃 |

### M.4 风险与降级

| 风险 | 缓解 |
|---|---|
| mestar 服务启动时不可达 | McpCatalogCache 失败不阻塞 boot：有缓存用过期缓存，无缓存跳过该 server |
| Embedding 服务不可达 | EmbeddingRouter 降级跳过，直接走 LlmToolResolver（全量，慢但不崩） |
| 规则派生 semanticTags 覆盖率低 | unknown 标记的工具走 Embedding/LLM 兜底，后台 LLM 派生补全 |
| catalog 全量拉取慢（2850 项） | 分页 + 进度日志；首次启动慢但后续走缓存 |

---

## Phase K：Mock 统一开关 + 三档降级链（已落地，横切）

**目标**：把分散的 mock 控制点（域取证 mock + mock MCP 动作）收敛为单一环境变量 `NEXUS_MOCK_TOOLS`；mock 关闭时通过 `systemPrompt` 纪律 + `precondition` 双模式判定，让 LLM 走 mestar MCP 三档降级链而非静默失败。

**relos 依赖**：无（与 Phase M 同属横切，可独立交付）

**完整规范**：详见 [07-mestar-integration-spec.md §9.2](07-mestar-integration-spec.md)

**任务清单**（全部 ✅ 完成）：

| # | 任务 | 产出文件 |
|---|---|---|
| K.1 | boot.ts 实现 `NEXUS_MOCK_TOOLS` 多档解析 + `NEXUS_MOCK_ACTIONS` 向后兼容 | `apps/nexusops/server/boot.ts`（修改） |
| K.2 | `buildNexusTools` 加 `includeEvidence` 参数（false 时跳过域工具，仅注册 finalize+advise） | `apps/nexusops/tools/index.ts`（修改） |
| K.3 | `buildMockModePrompt` 注入降级纪律段到 `systemPrompt`（全开返回空，向后兼容） | `apps/nexusops/server/boot.ts`（修改） |
| K.4 | `preconditions.ts` `ALL_GATES` 扩展到 10 域 + `isEvidenceToolsOff` / `hasAttemptedMcpEvidence` 双模式判定 | `apps/nexusops/server/preconditions.ts`（修改） |
| K.5 | `.env` / `.env.example` 变量替换 + 文档 | `.env.example`（修改） |

**验收**：`NEXUS_MOCK_TOOLS=0` 时启动日志输出 "mock 域取证工具已关闭"，systemPrompt 含三档降级纪律段；单元测试在 `beforeEach` 显式 `delete process.env.NEXUS_MOCK_TOOLS` / `NEXUS_MOCK_ACTIONS` 隔离 `.env` 污染。

---

## 里程碑总览

| 里程碑 | 内容 | 预估工时 | 前置条件 |
|---|---|---|---|
| **M0**（Phase 0） | 抽象接口 + MockOrchestrator + 数据 | ~3-4 天 | 无 |
| **M1**（Phase 1） | 报表组件化 | ~2-3 天 | M0 |
| **M2**（Phase 2） | 报表固化闭环 | ~2-3 天 | M1 |
| **M3**（Phase 3） | 接入 relos | ~3-4 天 | relos 可用 |
| **M4**（Phase 4） | skill 退化 + LLM 主导 | ~3-5 天 | M3 |
| **M5**（Phase M） | Mestar MCP 接入（catalog 模式 + 五层解析管道） | ~5.5 天 | 无（横切，可独立交付） |
| **M6**（Phase K） | Mock 统一开关 + 三档降级链 | ~1.5 天 | 无（横切，纯配置层收敛） |

**总计**：约 13-19 个工作日（Phase 0-4 + Phase M）；Phase K 约 1.5 天。

**可并行项**：Phase 1 和 Phase 2 可与 Phase 3 并行（Phase 3 等 relos 就绪期间，前端/报表工作可推进）。

---

## 关键依赖图

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──────────────→ Phase 4
   │                                         ↑
   └──→ Phase 3（relos 可用时启动）──────────┘

Phase M（Mestar MCP，横切）── 可在任何 Phase 后独立交付
Phase K（Mock 统一开关，横切）── 纯配置层收敛，可在 Phase 0 后任意时点启用
```

- Phase 0 是所有后续的基础
- Phase 1-2 不依赖 relos，可与 Phase 3 并行
- Phase 4 依赖 Phase 3（需要 Orchestrator 在线）+ Phase 1（需要组件化报表）
- **Phase M（Mestar MCP）与 relos 正交**：可在 Phase 0 后任何时点独立交付。relos 提供"该用什么方法论/需要什么语义数据"，mestar 提供"该语义数据用哪个具体工具获取"，两者协同工作。
- **Phase K（统一开关）**：纯配置层收敛，不依赖任何其他 Phase。与 Phase M 协同（关 mock 后默认走 mestar 三档降级链），但本身可在 Phase 0 后任意时点启用。

---

## 附录 A：跨 Phase 的全局测试矩阵

| 测试类型 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase M | Phase K |
|---|---|---|---|---|---|---|---|
| 单元测试（MockOrchestrator） | ✅ 新增 | 维护 | 维护 | 维护 | 维护 | — | — |
| 单元测试（ReportComponents） | — | ✅ 新增 | 维护 | 维护 | 维护 | — | — |
| 单元测试（SkillRegistry） | ✅ 扩展 | — | ✅ 扩展 | 维护 | 维护 | — | — |
| 集成测试（FallbackChain） | — | — | — | ✅ 新增 | 维护 | — | — |
| E2E（固化闭环） | — | — | ✅ 新增 | 维护 | 维护 | — | — |
| 回归测试（现有 172 测试） | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过 | ✅ 全过（含 env 隔离） |
| E2E（LLM 主导分析） | — | — | — | — | ✅ 新增 | — | — |
| 单元测试（McpCatalogCache） | — | — | — | — | — | ✅ 新增（10 用例） | — |
| 单元测试（EmbeddingToolRouter） | — | — | — | — | — | ✅ 新增（8 用例） | — |
| E2E（Mestar 全链路） | — | — | — | — | — | ✅ 新增（4 用例） | — |
| 回归（三档降级链 env 隔离） | — | — | — | — | — | — | ✅ before-delete env |

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
| D12 大目录 MCP 用 catalog 模式 | 用户确认（Phase M） | 00 §2；07 §1 |
| D13 工具路由用 Embedding 而非关键词 | 用户确认（Phase M） | 00 §2；07 §6 |
| D14 semanticTags 规则派生 + 后台 LLM 派生 | 用户确认（Phase M） | 00 §2；07 §5 |
| D15 catalog 三份缓存分离 | 架构推导（Phase M） | 00 §2；07 §3 |
| D16 catalog 执行用 LazyMcpActionTool 单代理 | 架构推导（Phase M） | 00 §2；07 §7 |
| D17 Embedding 用 ai SDK 内置能力（零新依赖） | 架构推导（Phase M） | 00 §2；07 §6 |
| D18 Mock 统一开关 + 三档降级链（NEXUS_MOCK_TOOLS 4 档） | 用户确认（Phase K） | 00 §2；07 §9.2；本文 Phase K |
