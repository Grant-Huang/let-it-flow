# 09 - 里程碑与 TodoList

本文档把开发工作划分为**三个阶段**（采纳自详细设计文档 §6），每个阶段下含若干细粒度里程碑（便于 TDD 渐进）。每个里程碑包含：目标、输入、输出文件、验收标准、测试用例、TDD 策略、风险点。

## 9.0 开发原则

- **TDD**：每个里程碑先写测试（测试冻结后不改断言），再实现业务代码
- **渐进式**：每个里程碑完成后跑测试门禁，用户确认后进入下一步
- **最小改动**：参考 `reference/` 的设计理念（不复用 Python 代码），TS 原生实现
- **门禁先行**：`scripts/test-gates.sh` 作为每次提交的强制检查

## 9.1 测试门禁

```bash
./scripts/test-gates.sh
```

7 道关卡（TS 化）：
1. 类型检查（`tsc --noEmit`）
2. Lint（`eslint .`）
3. 后端单元测试（`vitest run tests/unit/`）
4. 后端入口冒烟（`import { app } from "./src"`）
5. Planner 评测基准线（`pnpm eval --min-score 70`，仅 planner 相关 PR 触发）
6. 端到端测试（`vitest run tests/e2e/`，`@e2e` 标记，默认排除）
7. 前端构建（`next build`，前端阶段启用）

测试组织：`tests/unit/` 单元测试默认跑（mock 工具），`tests/e2e/` 端到端测试默认排除。

---

## 阶段总览（采纳详细设计文档 §6，融合 SDK/HITL 调整）

```mermaid
flowchart LR
    subgraph phase1 [阶段一: 微内核解耦]
        M1["M1 内核骨架 + SDK 入口"] --> M2["M2 任务与流式 + HITL 基础"]
        M1 --> M3["M3 工具协议层"]
        M2 --> M6["M6 知识库接口"]
        M3 --> M6
    end
    subgraph phase2 [阶段二: 编译器实现]
        M4["M4 DAG Executor + HITL 集成"] --> M5["M5 Planner + 评测"]
    end
    subgraph phase3 [阶段三: 工程化闭环]
        M7["M7 示例消费应用"]
    end
    phase1 --> phase2 --> phase3
```

| 阶段 | 含义 | 里程碑 | 预估 |
|------|------|--------|------|
| 阶段一 | 微内核解耦（抽出通用核心 + SDK） | M1, M2, M3, M6 | 7.5 天 |
| 阶段二 | 编译器实现（Intent-to-DAG + HITL） | M4, M5（含评测） | 6 天 |
| 阶段三 | 工程化闭环（示例 + CI） | M7 | 2.5 天 |

---

## 阶段一：微内核解耦

### M1 - 内核骨架 + SDK 入口

**目标**：项目可启动、可导入，最小 Hono 应用跑通；**SDK 入口（`LetItFlow` 类骨架）可实例化**。

**输入**：参考 docs/02-architecture.md 技术栈与目录结构、SDK 双形态架构

**输出文件**：
- `package.json` - 依赖（hono / zod / ai / vitest / typescript）
- `tsconfig.json` - strict 模式
- `vitest.config.ts`
- `eslint.config.mjs`
- `vercel.json`
- `src/index.ts` - 导出 Hono app + LetItFlow 双入口
- `src/sdk/let-it-flow.ts` - LetItFlow 类骨架（装配 planner/executor/tools 的占位）
- `src/core/config.ts` - DATA_DIR / 环境变量
- `src/core/response.ts` - ok()/err()
- `src/core/streaming.ts` - SSE v1.0 协议
- `src/core/stream-events.ts` - 事件构造

**验收标准**：
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm dev` 启动，`GET /` 返回 200
- [ ] `pnpm test` 通过（至少 1 个冒烟测试）
- [ ] SDK 入口可 import：`import { LetItFlow } from "./src"` 不报错

**测试用例**（TDD，先写）：
- `tests/unit/test-smoke.ts::test app imports`
- `tests/unit/test-smoke.ts::test health endpoint`
- `tests/unit/test-sdk.ts::test LetItFlow instantiates`

**风险**：AI SDK v6 的 import 路径需核对（`generateText`/`Output` 从 `ai` 包导入）

---

### M2 - 任务与流式机制 + HITL 基础

**目标**：Task 创建 + 流式订阅跑通（用 stub DAG）；**HITL 暂停基础设施（AsyncLatch + pending_confirmation 状态 + confirmation_required 事件）就绪**（暂停点暂用 stub 触发，真实集成在 M4）。

**输入**：docs/08-task-streaming.md + docs/12-hitl-and-control.md（§12.3-12.4 暂停机制）

**输出文件**：
- `src/tasks/task-store.ts` - TaskStore 接口 + FileTaskStore（含 `pending_confirmation` 状态）
- `src/tasks/latch.ts` - AsyncLatch 异步闩锁
- `src/tasks/registry.ts` - TaskRegistry（runner 执行 stub + awaitConfirmation/confirm 方法）
- `src/tasks/coalescer.ts` - StreamCoalescer + EventBatchBuffer
- `src/api/workflows.ts` - POST /api/workflows
- `src/api/tasks.ts` - GET /api/tasks/:id/stream + POST /api/tasks/:id/confirm
- `src/storage/file-store.ts` - 最小化（仅 task 存储布局）

**验收标准**：
- [ ] `POST /api/workflows {intent: "test"}` 返回 taskId
- [ ] `GET /api/tasks/:id/stream` 收到 stage 事件
- [ ] stub runner 完成后收到 done 事件
- [ ] 断线重连（since=N）能续传
- [ ] stub 触发暂停时任务进入 `pending_confirmation` 并发 `confirmation_required` 事件
- [ ] `POST /api/tasks/:id/confirm` 恢复执行，任务回到 `running`

**测试用例**：
- `tests/unit/test-task-store.ts::test create and get task`
- `tests/unit/test-task-store.ts::test append and list events`
- `tests/unit/test-task-streaming.ts::test post workflow returns task id`
- `tests/unit/test-task-streaming.ts::test sse stream delivers events`
- `tests/unit/test-task-streaming.ts::test reconnect with since`
- `tests/unit/test-hitl.ts::test latch wait and release`
- `tests/unit/test-hitl.ts::test pause emits confirmation_required`
- `tests/unit/test-hitl.ts::test confirm resumes task`

---

### M3 - 工具协议层

**目标**：FlowConnector 接口 + 分层注册表 + 内置工具可独立执行并产出事件；**AutonomousResearchTool（Agent-as-Tool）骨架就位**（内部 ReAct 循环可后续迭代）。

**输入**：docs/04-tool-protocol.md（含 §4.6 domain 层 AutonomousResearchTool）

**输出文件**：
- `src/tools/base.ts` - FlowConnector 接口 + ToolResult + StreamEvent 类型（含 confirmation_required/progress）
- `src/tools/registry.ts` - 分层 ToolRegistry（core/domain/custom）+ 工具向量预计算缓存
- `src/planner/tool-router.ts` - 两阶段动态工具检索（粗筛分层 + 精排向量 top-K，见 04 §4.7）
- `src/tools/base.ts` - FlowConnector 接口（含工具契约字段 whenToUse/outputExample）
- `src/tools/http-tool-provider.ts` - flow-manifest 自描述外部工具接入
- `src/tools/providers/` - web 检索/抓取 provider 实现
- `src/tools/builtin/web-search.ts`
- `src/tools/builtin/web-fetch.ts`
- `src/tools/builtin/llm-node.ts`
- `src/tools/builtin/deliver.ts`
- `src/tools/builtin/autonomous-research.ts` - AutonomousResearchTool（domain 层，受限 ReAct 循环）
- `src/services/llm-service.ts` - 按角色注入

**验收标准**：
- [ ] WebSearchTool.execute() 产出 stage/tool_call/tool_result 事件
- [ ] WebFetchTool.execute() 接收 inputRefs 并抓取
- [ ] LLMNodeTool.execute() 流式产出 text 事件（用 `streamText`）
- [ ] 注册表 listByTier() 按分层过滤正确
- [ ] AutonomousResearchTool 在 `stepCountIs(N)` 限制内停止（mock LLM）
- [ ] 所有内置工具含完整契约（whenToUse/outputExample），`forPlanner()` 返回契约字段
- [ ] http-tool-provider 拉取 flow-manifest.json 并注册工具（mock manifest）

**测试用例**：
- `tests/unit/test-tool-registry.ts::test register and get`
- `tests/unit/test-tool-registry.ts::test list by tier`
- `tests/unit/test-web-search-tool.ts::test execute yields events`（mock provider）
- `tests/unit/test-web-fetch-tool.ts::test resolves input refs`
- `tests/unit/test-llm-node-tool.ts::test streams text`（mock LLM）
- `tests/unit/test-autonomous-research.ts::test respects step limit`（mock LLM）

---

### M6 - 知识库接口（IKnowledgeProvider）

**目标**：DAG 可调用知识库（IKnowledgeProvider 抽象 + HTTP 协议 + 内置 ObsidianProvider 示例）。

**输入**：docs/05-kb-mcp-protocol.md（含 §5.8 Chunking、§5.9 读写分离、§5.10 ObsidianProvider、§5.12 MCP 桥接）

**输出文件**：
- `src/tools/knowledge/provider.ts` - IKnowledgeProvider + KnowledgeChunk schema（含 queryStream/append/update 可选方法 + versioned 能力）
- `src/tools/knowledge/http-provider.ts` - HttpKnowledgeProvider
- `src/tools/knowledge/mcp-provider.ts` - McpKnowledgeProvider（内置 MCP 桥接适配器，零代码接入 MCP 生态）
- `src/tools/knowledge/obsidian-provider.ts` - ObsidianProvider（内置示例，按二级标题 Chunking + mtime 增量同步）
- `src/tools/knowledge/write-conflict.ts` - WriteConflictError + 冲突策略（skip/rename/overwrite，见 05 §5.9）
- `src/tools/builtin/knowledge-base.ts`
- `examples/mock-kb-server/index.ts`
- `tests/helpers/mock-kb.ts`

**验收标准**：
- [ ] mock KB server 启动并响应 /kb/search
- [ ] KnowledgeBaseTool 调用成功并返回 results
- [ ] KB 不可达时降级为空结果（不中止 DAG）
- [ ] DAG 含 knowledge_base 节点时端到端执行通过
- [ ] ObsidianProvider（SDK 注入）可查询本地 vault 并按标题切分 chunk
- [ ] McpKnowledgeProvider 接入 mock MCP Server，探测能力并正确映射 query/append
- [ ] **写冲突防护：update 携带过期 expectedVersion 时抛 WriteConflictError，按 skip 策略不阻塞 deliver**
- [ ] **增量同步：ObsidianProvider 增改文件后 refresh() 仅重索引变更项（mtime 比对）**

**测试用例**：
- `tests/unit/test-knowledge-base-tool.ts::test search action`（mock fetch）
- `tests/unit/test-knowledge-base-tool.ts::test retrieve action`
- `tests/unit/test-knowledge-base-tool.ts::test unreachable degrades gracefully`
- `tests/unit/test-obsidian-provider.ts::test query matches keyword and tags`
- `tests/unit/test-obsidian-provider.ts::test splits by headings`
- `tests/e2e/test-kb-e2e.ts::test dag with kb node`（@e2e，启 mock server）

---

## 阶段二：编译器实现

### M4 - DAG Executor + HITL 集成

**目标**：多节点 DAG 可端到端执行（mock 工具），JSONPath 引用正确解析；**HITL 暂停点接入 executor（规划确认 + 节点结果确认）**；**onNodeError 三策略（abort/skip/retry）落地**。

**输入**：M3 的工具层 + M2 的 HITL 基础 + docs/03-dag-schema.md（含 requireConfirmation/onNodeError）+ docs/07-executor.md + docs/12-hitl-and-control.md

**输出文件**：
- `src/planner/dag-schema.ts` - WorkflowDAG/Task Zod schema（含 requireConfirmation/requirePlanConfirmation/onNodeError/retryAttempts/contentPipeline）
- `src/executor/executor.ts` - 拓扑分层 + Promise.all 并发执行 + HITL 暂停点 + onNodeError 策略分发
- `src/executor/context.ts` - ExecutionContext（jsonpath-plus）
- `src/executor/node-runner.ts` - 节点执行 + 确认等待 + progress 事件透传
- `src/executor/content-pipeline.ts` - 数据清洗管道（strip/summarize/truncate，形状感知，见 07 §7.6）
- `src/tasks/latch.ts` - AsyncLatch 进程内异步闩锁（见 12 §12.4）
- `src/tasks/state-snapshot.ts` - 暂停点状态快照持久化 + Serverless 冷启动恢复（见 12 §12.5）

**验收标准**：
- [ ] 单层 DAG（3 个并行 search）并发执行
- [ ] 多层 DAG（search → fetch → llm → deliver）顺序正确
- [ ] JSONPath 引用（`$.tasks.id.output.field`）正确解析
- [ ] 单节点失败时按 onNodeError=abort 中止 DAG 并报错
- [ ] onNodeError=skip 时失败节点置空、下游继续、deliver 标记 partial
- [ ] onNodeError=retry 时失败节点按 retryAttempts 重试，耗尽后中止
- [ ] **Content Pipeline：web_fetch 大输出（>maxTokens）经 strip+truncate 压缩后注入下游，不触发 400**
- [ ] **Content Pipeline 形状感知：结构化数组/对象透传，不被无差别摘要拍平**
- [ ] 工具内 yield 的 progress 事件被透传到 SSE（status 通道立即落库）
- [ ] `requirePlanConfirmation` 的 DAG 规划后暂停，确认后恢复
- [ ] `node.requireConfirmation` 的节点执行后暂停，确认后用结果继续下游

**测试用例**：
- `tests/unit/test-dag-schema.ts::test dag validation`（Zod）
- `tests/unit/test-executor.ts::test topological layers`
- `tests/unit/test-executor.ts::test concurrent layer execution`（mock 工具）
- `tests/unit/test-executor.ts::test variable resolution`（JSONPath）
- `tests/unit/test-executor.ts::test node failure aborts`
- `tests/unit/test-executor.ts::test node failure skips (onNodeError=skip)`
- `tests/unit/test-executor.ts::test node failure retries (onNodeError=retry)`
- `tests/unit/test-executor.ts::test progress event passthrough`
- `tests/unit/test-content-pipeline.ts::test strip removes html noise`
- `tests/unit/test-content-pipeline.ts::test truncate enforces maxTokens`
- `tests/unit/test-content-pipeline.ts::test structured array passes through unchanged`
- `tests/unit/test-content-pipeline.ts::test summarize (opt-in) compresses long text`
- `tests/unit/test-executor.ts::test cancel check`
- `tests/unit/test-executor.ts::test plan confirmation pauses and resumes`
- `tests/unit/test-executor.ts::test node confirmation pauses and resumes`

---

### M5 - Planner + 评测基准线

**目标**：自然语言意图 → DAG（经 AI SDK 结构化输出）→ 校验通过 → 执行完成；**并建立 50 用例评测集**。

**输入**：M4 的 DAG schema + executor + docs/06-planner-and-templates.md + docs/11-benchmark-and-eval.md

**输出文件**：
- `src/planner/planner.ts` - planner（经 `guardedGenerateObject` 守护的结构化输出）
- `src/planner/templates.ts` - 模板路由 + 骨架
- `src/planner/guardrail.ts` - Guardrail 可行性判断（规则层：proceed/clarify/reject）
- `src/planner/fallback.ts` - Fallback DAG 降级兜底（解析/校验反复失败时，见 06 §6.6）
- `src/planner/validator.ts` - DAG 校验
- `src/planner/prompts/system-prompt.md` - 契约式 System Prompt
- `src/planner/prompts/few-shots/` - 黄金示例库（5 个）
- `src/llm/robust-output-guard.ts` - 结构化输出鲁棒守卫（native/weak 双路径，见 02 §2.8）
- `src/llm/json-repair.ts` - 鲁棒 JSON 解析（平衡括号提取 + 尾逗号/未闭合修复）
- `src/api/tasks.ts`（扩展）- 新增 `POST /:id/clarify` 端点
- `eval/cases/case-schema.ts` - 评测用例 Zod schema
- `eval/cases/*.json` - 50 个评测用例
- `eval/runner.ts` - 断言评分引擎
- `eval/run-all.ts` - 评测集执行入口

**验收标准**：
- [ ] "分析XX行业" 命中 research 模板
- [ ] "生成播客" 命中 content 模板
- [ ] Planner 经 guardedGenerateObject 输出合法 DAG（Zod 校验通过）
- [ ] **弱模型（structuredSupport=weak）下，带 ```json 包裹/尾逗号/未闭合括号的输出经鲁棒解析成功还原**
- [ ] **解析失败计入重试循环，3 次耗尽后降级为 Fallback DAG（非崩溃）**
- [ ] Validator 检测出环/缺 deliver/未注册工具等错误
- [ ] Guardrail：模糊意图（如"看看那个股票"）触发 clarification_required；越界意图（如"点咖啡"）触发 rejected
- [ ] clarify 端点补充信息后用合并意图重跑 planner（原 task id 复用）
- [ ] 端到端：意图 → 执行 → deliver 产物
- [ ] **评测基准线：50 用例平均分 ≥ 70**（CI 门禁）

**测试用例**：
- `tests/unit/test-templates.ts::test route research`
- `tests/unit/test-templates.ts::test route content`
- `tests/unit/test-validator.ts::test detects cycle`
- `tests/unit/test-validator.ts::test detects missing deliver`
- `tests/unit/test-planner.ts::test plan yields valid dag`（mock LLM 返回固定 DAG）
- `tests/unit/test-planner.ts::test retry on validation failure`
- `tests/unit/test-json-repair.ts::test extract balanced object ignores code fences`
- `tests/unit/test-json-repair.ts::test repair trailing comma and unclosed brackets`
- `tests/unit/test-robust-output-guard.ts::test native path uses output.object`
- `tests/unit/test-robust-output-guard.ts::test weak path parses dirty json`
- `tests/unit/test-planner.ts::test fallback dag on retry exhaustion`
- `tests/unit/test-eval-runner.ts::test score case syntax`（mock DAG）
- `tests/unit/test-eval-runner.ts::test score case tools`
- `tests/unit/test-eval-runner.ts::test score case logic`

**风险**：AI SDK `Output.object` 在弱结构化模型上不稳定 → 已由 `RobustOutputGuard`（native/weak 双路径 + 鲁棒解析 + Fallback DAG）守护（见 02 §2.8），评测阈值设 70 给调优空间。Content Pipeline 的 summarize 阶段（付费小模型摘要）默认关，仅高价值长文档节点显式开启。

---

## 阶段三：工程化闭环

### M7 - 示例消费应用

**目标**：覆盖 SDK 与 HTTP 两种形态的示例端到端可演示。

**输出文件**：
- `examples/sdk-embedded/` - SDK 形态示例（进程内 LetItFlow + ObsidianProvider）
- `examples/stock-analysis/` - HTTP 形态示例（调 POST /api/workflows + 消费 SSE）
- `examples/podcast-generator/` - 含 mock KB server + TTS stub + HITL 筛选演示
- `examples/obsidian-kb-server/` - ObsidianProvider 远程部署示例（HTTP 线协议）
- `examples/litpilot-as-consumer/migration.md` - 迁移说明（设计参考）
- `frontend/` - 最小演示页（输入意图 + 显示 DAG + 流式展示 + HITL 确认 UI）

**验收标准**：
- [ ] sdk-embedded 示例进程内执行意图并收到产物
- [ ] stock-analysis 示例提交意图并收到分析报告 artifact
- [ ] podcast-generator 示例启 KB server + 提交意图收到脚本，HITL 筛选可交互
- [ ] 前端演示页能渲染 DAG 节点状态、流式 text、HITL 确认弹窗

---

## 9.2 整体时间估算

| 里程碑 | 阶段 | 预估工作量 | 依赖 |
|--------|------|-----------|------|
| M1（含 SDK 入口） | 一 | 1 天 | 无 |
| M2（含 HITL 基础） | 一 | 2 天 | M1 |
| M3（含 Agent-as-Tool） | 一 | 2.5 天 | M1 |
| M6（含 ObsidianProvider） | 一 | 2 天 | M3 |
| M4（含 HITL 集成） | 二 | 2.5 天 | M3, M2 |
| M5（含评测） | 二 | 3.5 天（含 50 用例编写） | M4 |
| M7（含 SDK 示例） | 三 | 2.5 天 | M5, M6 |

M2 和 M3 可并行（都依赖 M1）。M6 与 M4 可并行（都依赖 M3）。总计约 16 个工作日。

> 相比初版（约 12-13 天），增量来自：SDK 入口（M1 +0.5）、HITL 基础与集成（M2/M4 +1.5）、Agent-as-Tool（M3 +0.5）、ObsidianProvider 内置（M6 +1）、SDK 示例（M7 +0.5）。

## 9.3 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| AI SDK `Output.object` 结构化输出不稳定 | planner 输出非法 DAG | Validator + 最多 3 次重试；评测阈值 70 给调优空间 |
| web_fetch 抓取失败率高 | 内容不足 | 多段降级 native_fetch（设计参考 LitPilot） |
| 知识库服务性能不一 | 执行卡顿 | 超时控制 + 降级为空结果 |
| 复杂意图超出模板覆盖 | DAG 不合理 | 通用骨架兜底 + 后续扩展模板库 |
| 50 用例编写工作量大 | M5 延期 | 分批：M5 先建 20 用例，后续迭代补齐 |
| HITL 暂停导致 serverless 冷启动/超时 | 任务卡死 | sweeper 超时转 cancelled；长任务建议 SDK 形态或长跑 worker |
| AutonomousResearchTool 内部循环失控 | token 消耗爆炸 | `stopWhen: stepCountIs(N)` 硬上限 + 平台二次校验上限 |

## 9.4 待确认的细化点（后续迭代）

以下在 M1-M7 之外，视需求纳入：
- 多轮对话（同一 workflow 内追问）
- 工具权限与沙箱（自定义工具的安全约束）
- 产物版本管理（同 artifact 多版本）
- 多租户与配额（多消费应用隔离）
- 知识库 queryStream 流式检索实现（M1 仅纳入接口，实现延后）

### 规划质量增强（M5 后迭代）

下列规划能力增强项已在设计中预留接口/章节，但不在 M1-M7 实装范围，待 M5 评测体系跑通后按效果决定是否纳入：

| 增强项 | 设计位置 | 说明 |
|--------|---------|------|
| **LLM Critic 审校**（Refinement Loop） | 06 §6.8 | Validator 后插入小模型语义审查，检查关键约束遗漏。`critiqueDag()` 接口已预留，`criticEnabled` 默认关闭 |
| **失败记忆 / Negative Constraint** | 11（待补） | 把执行失败的 `(intent, failedNode, reason)` 沉淀为记忆，下次相似意图规划时注入为负约束（"上次 web_fetch 抓某站失败，这次换搜索 API"） |
| **Dry Run 沙盒预演** | 07（待补） | `executeDag({ dryRun: true })` 用 mock output 空跑，校验所有 JSONPath 引用可解析、数据流闭环，在真实执行前预测失败 |
| **断点续传（Resume）** | 07 §7.4 | `POST /api/tasks/:id/resume` 从失败层后继重启，已成功层从中间产物缓存读取，不重头规划。地基（缓存 + 失败保留）已在 M1 预留 |
| **修复 Agent（Repair Agent）** | 07 §7.4 | 失败时启动微型 Agent，拿 `(失败节点, 入参, 错误, 替代工具)` 产出"微调入参/换工具"建议重跑该节点，不动整图 |
| **Guardrail 小模型语义层** | 06 §6.7 | 规则层 Guardrail 之上的语义判定升级：用低成本模型判断越界/模糊，规则层兜底，覆盖规则遗漏的边界 |
| **Clarification 多轮后置合并** | 12 §12.8 | 多轮 clarify 的补充信息累积合并到意图上下文，而非简单覆盖 |
| **Content Pipeline summarize 阶段** | 07 §7.6 | 滚动窗口摘要（调小快模型按 intent 抽取核心事实）。M4 实装 strip+truncate（免费），summarize 因付费/延迟默认关，按节点显式开启；待评测确认收益后考虑自动触发策略 |
| **工具向量精排的自动触发阈值** | 04 §4.7 | M3 实装粗筛（分层）+ 精排（向量 top-K），但精排仅在候选 > TOP_K(10) 时触发；后续可根据 registry 规模动态调参，或引入两级缓存（热门意图→工具集）进一步降延迟 |
| **KB 增量同步的变更游标协议** | 05 §5.9 | M6 实装 mtime 轮询（ObsidianProvider）+ MCP resources/list；远程 HTTP provider 的 `GET /changes?since={cursor}` 时序游标协议待标准化后纳入 |

> 注：HITL（人工干预）、MCP 桥接（McpKnowledgeProvider）、工具契约（whenToUse/outputExample）、flow-manifest 已**纳入核心设计**（M2/M3/M4/M6），不再属于待确认点。`onNodeError` 三策略（abort/skip/retry）、`progress` 细粒度事件、Content Pipeline（strip+truncate）、RobustOutputGuard（多模型结构化输出守卫）+ Fallback DAG、两阶段工具检索（粗筛+精排）、KB 读写冲突防护（乐观锁）、HITL 状态快照持久化（Serverless 冷启动恢复）已纳入 M3/M4/M5/M6 核心实装。

## 9.5 相关文档

- [02-architecture.md](02-architecture.md) - 技术栈与 SDK/HTTP 双形态目录结构
- [11-benchmark-and-eval.md](11-benchmark-and-eval.md) - 评测体系详情（M5 子任务）
- [12-hitl-and-control.md](12-hitl-and-control.md) - HITL 设计（M2/M4 子任务）
- [10-litpilot-migration-guide.md](10-litpilot-migration-guide.md) - 与 LitPilot 关系
