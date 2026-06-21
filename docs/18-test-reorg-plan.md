# 18 - 测试重新组织方案（podcast 重构后）

> 配套：[09-milestones-and-todolist.md](09-milestones-and-todolist.md)、[14-podcast-generator-frontend.md](14-podcast-generator-frontend.md)（已过时）、[15-harness-engineering.md](15-harness-engineering.md)
>
> 触发：commit `76ebb5a Restructure podcast apps into single ai-content-factory app` 把 podcast-skill + podcast-generator 合并成 `apps/ai-content-factory`，podcast 业务流程从 **planner + DAG + ConsumerTemplate** 切换到 **ReAct harness + skill 模式**（customRunner 接管执行）。需要梳理：哪些测试在旧架构下编写、在新架构下已失效或语义错位。

## 18.1 现状盘点（事实基础）

### 18.1.1 测试目录与命令

| 入口 | 命令 | 范围 | 状态 |
|------|------|------|------|
| vitest 单测 | `pnpm test` | `tests/unit/**/*.ts`（34 文件 / 509 用例） | ✅ 全绿（含在线 `test-p6-sdk`） |
| 全量测试报告 | `pnpm full-test` | 离线默认跳过 `test-p6-sdk` + `tests/e2e/` | ✅ 离线全绿 |
| 场景测试 | `pnpm scenarios` | `tests/scenarios/run.ts` 聚合 V/G/C/L/T/E 六层 | ❌ E2 失败（2/2 断言） |
| e2e | 手动 `tsx tests/e2e/*.ts` | 真实 LLM 全链路 + fixture 录制/回放 | ⚠️ fixtures 是失败时录的空数据 |

### 18.1.2 失败点定位

- **`scenarios E2`** 失败：`tests/e2e/fixtures/podcast-*.json` 两个 fixture 都是录制时任务 failed/error、`calledTools=[]`、`stepCount=0` 的空数据（重构前 5 个 bug 未修时录制）。replay 模式回放空数据，断言"含 web_search + thread_focuser"必然失败。
- **vitest 单测**：虽然全绿，但耦合到旧 podcast-generator 的测试语义已错位（详见 §18.2）。

### 18.1.3 架构变更对测试的影响范围

`src/planner/*` 模块本身**没有**被生产代码完全废弃 —— SDK 入口 `src/sdk/let-it-flow.ts` 与 `src/tasks/registry.ts` 的 `runPlanned` runner 仍引用它，所以 planner/executor 单测仍验证有效的内核 SDK 路径。

真正失效的边界是**消费应用层**：
- 旧 `apps/podcast-generator` + `apps/podcast-skill` 已删除；
- 新 `apps/ai-content-factory` 用 ReAct harness，**不再使用 ConsumerTemplate / podcast DAG**；
- `examples/podcast-generator/`（SDK demo + template + toolkit）仍存在，但只是 SDK 用法示例，**不再对应任何运行的生产代码**。

## 18.2 失效/语义错位测试清单

按"失效程度"分级（**A 完全失效** / **B 部分错位** / **C 仍有效但需重命名**）：

### A. 完全失效（验证的是已删除的 podcast-generator 路径）

| 文件 | 行数 | 失效原因 | 建议 |
|------|------|----------|------|
| `tests/unit/test-p4-planner.ts` | 282 | 直接 `import { podcastTemplate, buildPodcastDag } from "../../examples/podcast-generator/template.js"`；验证旧 ConsumerTemplate 路径，新架构 ai-content-factory 不走此路 | **删除** |
| `tests/unit/test-p4-api.ts` | ~150 | `consumerTemplates: [podcastTemplate]` 注入 + HTTP 跑旧 podcast DAG 流程；对应 `apps/podcast-generator` 已删除 | **删除** |
| `tests/unit/test-p5-heavy-io.ts` | 243 | `buildPodcastDag` 的 10 节点完整视频链 DAG 构造测试；完整链工具（`domain.translate/rewrite/...`）从未在 ai-content-factory 注册 | **删除**（domain.* 工具集已被 skill.* 取代） |

### B. 部分错位（planner 路径仍有效，但 podcast 模板耦合需替换）

| 文件 | 行数 | 错位点 | 建议 |
|------|------|--------|------|
| `tests/unit/test-p6-sdk.ts` | ~150 | `new LetItFlow({ consumerTemplates: [podcastTemplate] })` —— SDK 形态仍支持，但用 podcast 模板做 e2e 已错位；48s 在线测试跑真实 LLM | **改**：保留 SDK HITL 测试，把意图从"播客"换成中性研究类（"研究 X 并交付"），去掉对 podcastTemplate 的依赖 |
| `tests/unit/test-p7-llm-router.ts` | ~120 | `consumerTemplates: [podcastTemplate]` 作为兜底模板；planner LLM 路由本身仍有效 | **改**：用临时构造的最小 ConsumerTemplate 替代 podcastTemplate，保留 planner 路由断言 |
| `tests/unit/test-p7-tool-contract.ts` | 275 | 同上，用 podcastTemplate 验证"LLM 不可用回退模板" | **改**：同上，替换为内联最小模板 |

### C. 仍有效但与重构语义脱节

| 文件 | 行数 | 说明 | 建议 |
|------|------|------|------|
| `tests/e2e/podcast-eval-harness.ts` | 378 | 仍正确（驱动 ai-content-factory），但函数命名 `runPodcastFlow` + fixture 文件名前缀 `podcast-` 已与"ai-content-factory"品牌不一致 | **重命名**（可选）：`runAicfFlow` / `aicf-*.json`；优先级低 |
| `tests/e2e/fixtures/podcast-*.json` | 2 个 | 失败时录的空数据 | **重录**：`pnpm tsx tests/e2e/run-podcast-record.ts` 重跑录制 |

### 不受影响（明确保留）

- `tests/unit/test-p1-*.ts / test-p2-*.ts / test-p3-executor.ts`：内核 HTTP/Tasks/Tools/Executor 单测，与消费应用无关
- `tests/unit/test-p8-*.ts`：配置/模型注册/绑定/tracer 单测
- `tests/unit/test-p9-*.ts`：NexusOps 相关，未受 podcast 重构影响
- `tests/unit/test-skill-*.ts / test-agent-harness.ts / test-governance-post.ts / test-review-pass.ts / test-prepare-step.ts`：ReAct harness + skill 框架，**正是新架构的核心**
- `tests/unit/test-multi-turn.ts / test-settings.ts / test-smoke.ts / test-tool-schema.ts / test-advise-validator.ts`：通用机制
- `tests/scenarios/*`：六层场景测试，结构与 ETCLOVG 对齐，仅 E2 因 fixture 失败

## 18.3 重新组织方案

### 18.3.1 目录结构调整

```
tests/
├── unit/                         # 单元测试（vitest）
│   ├── core/                     # 【新】内核机制（HTTP/Tasks/Tools/Executor/Stream/Config）
│   │   ├── test-api.ts           # ← test-p1-api.ts
│   │   ├── test-tasks.ts         # ← test-p1-tasks.ts
│   │   ├── test-tools.ts         # ← test-p2-tools.ts
│   │   ├── test-executor.ts      # ← test-p3-executor.ts
│   │   ├── test-settings.ts
│   │   ├── test-smoke.ts
│   │   ├── test-tool-schema.ts
│   │   ├── test-p8-config.ts
│   │   ├── test-p8-api-config.ts
│   │   ├── test-p8-migrate.ts
│   │   ├── test-p8-multiprovider.ts
│   │   └── test-p8-tracer.ts
│   ├── agent/                    # 【新】ReAct harness + skill 框架（ETCLOVG）
│   │   ├── test-agent-harness.ts
│   │   ├── test-prepare-step.ts
│   │   ├── test-review-pass.ts
│   │   ├── test-governance-post.ts
│   │   ├── test-skill-bridge-dsl.ts
│   │   ├── test-skill-confirm.ts
│   │   ├── test-skill-miner.ts
│   │   ├── test-skill-registry.ts
│   │   └── test-advise-validator.ts
│   ├── sdk/                      # 【新】SDK 形态（LetItFlow）+ planner 内核路径
│   │   ├── test-sdk-hitl.ts      # ← test-p6-sdk.ts（重构后，去 podcastTemplate 依赖）
│   │   ├── test-planner-router.ts # ← test-p7-llm-router.ts（去 podcastTemplate 依赖）
│   │   └── test-tool-contract.ts  # ← test-p7-tool-contract.ts（去 podcastTemplate 依赖）
│   └── apps/                     # 【新】消费应用相关
│       ├── nexusops/             # ← test-p9-*.ts 五个文件
│       └── aicf/                 # 【待建】ai-content-factory 装配/KB/skill 单测（如需补充）
├── e2e/
│   ├── podcast-eval-harness.ts   # （可选重命名为 aicf-eval-harness.ts）
│   ├── nexus-eval-harness.ts
│   ├── fixtures/
│   │   ├── aicf-*.json           # （可选重命名 + 重录）
│   │   └── nexus-*.json
│   ├── test-aicf-e2e.ts          # ← test-podcast-e2e.ts
│   ├── test-nexus-e2e.ts
│   ├── test-nexus-guardrails.ts
│   ├── test-v4-baseline.ts
│   ├── run-aicf-record.ts        # ← run-podcast-record.ts
│   └── (删除空 fixture 后重录)
└── scenarios/                    # 保持现状（V/G/C/L/T/E 六层不变）
```

**移动规则**：仅 `git mv`，不改文件内容，保证 blame 可追溯；内容改造单独提交。

### 18.3.2 删除清单（A 级失效测试）

| 删除文件 | 行数回收 | 替代物 |
|----------|----------|--------|
| `tests/unit/test-p4-planner.ts` | 282 | 无（podcast DAG 路径已废弃） |
| `tests/unit/test-p4-api.ts` | ~150 | 无（HTTP 跑旧 podcast 流程的测试，已被 scenarios E1 覆盖 ai-content-factory 装配） |
| `tests/unit/test-p5-heavy-io.ts` | 243 | 无（domain.* 完整视频链工具已被 skill.* 取代） |

合计回收 ~675 行失效代码。

### 18.3.3 改造清单（B 级部分错位）

| 改造文件 | 改造点 |
|----------|--------|
| `test-p6-sdk.ts` → `test-sdk-hitl.ts` | 把 `consumerTemplates: [podcastTemplate]` 改成内联最小 ConsumerTemplate（如 `templateId: "research"`，2 节点 search→deliver）；意图从"播客"改成"研究 X 并交付" |
| `test-p7-llm-router.ts` → `test-planner-router.ts` | 把 `podcastTemplate` 兜底用内联最小模板替代；断言不变 |
| `test-p7-tool-contract.ts` → `test-tool-contract.ts` | 同上 |

**保留断言逻辑**（TDD 规则：不弱化断言），只换"业务模板载体"。

### 18.3.4 重录清单（fixtures）

```bash
# 1. 删除空 fixture（必做，否则 replay 永远失败）
rm tests/e2e/fixtures/podcast-*.json

# 2. 重录（需 .env 有可用 OPENAI_API_KEY）
pnpm tsx tests/e2e/run-podcast-record.ts
```

重录会调用真实 LLM 跑完整 ai-content-factory 流程，录制可用 fixture。

### 18.3.5 配置同步

- `vitest.config.ts` 的 `include` 路径从 `tests/unit/**/*.ts` 自动适配子目录化，无需改。
- `scripts/full-test.ts` 的 `ONLINE_TESTS` 数组路径需同步更新（`test-p6-sdk.ts` → `test-sdk-hitl.ts`）。
- `pnpm-workspace.yaml` 与各 `package.json` 不受影响。

## 18.4 执行计划（Todolist）

按"最小风险 → 最大收益"排序，每步独立提交，便于回滚：

| # | 阶段 | 动作 | 风险 | 估时 |
|---|------|------|------|------|
| 1 | 清理 | 删除 A 级 3 个失效测试文件（test-p4-planner/api、test-p5-heavy-io） | 低（纯删除） | 5 min |
| 2 | 重录 | 删除空 fixture + 重跑 record 生成可用 fixture | 中（依赖 LLM 网络） | 5-15 min |
| 3 | 验证 | `pnpm scenarios` 应走绿（E2 修复） | - | 1 min |
| 4 | 改造 | B 级 3 个文件去 podcastTemplate 依赖（内联最小模板） | 中（需保持断言） | 20 min |
| 5 | 验证 | `pnpm test` 全绿（含在线测试） | - | 1 min |
| 6 | 重组 | 按 §18.3.1 用 `git mv` 把单测分子目录（core/agent/sdk/apps） | 低（仅移动） | 10 min |
| 7 | 同步 | 更新 `scripts/full-test.ts` 中 `ONLINE_TESTS` 路径 | 低 | 2 min |
| 8 | 可选 | 重命名 podcast-eval-harness → aicf-eval-harness（含 fixtures 前缀） | 低（机械替换） | 10 min |
| 9 | 验收 | `pnpm test && pnpm scenarios && pnpm full-test` 三套全绿 | - | 3 min |

**总估时**：约 60-75 分钟（步骤 2 的重录耗时取决于 LLM 响应）。

## 18.5 边界与不改动项

明确**不动**的范围，避免过度重构：

1. **不动 `src/planner/*` 模块**：SDK 路径仍使用它，只是消费应用不再使用。
2. **不动 `examples/podcast-generator/`**：SDK 用法示例，保留作为 LetItFlow 类的 reference。
3. **不动 `scenarios/` 六层结构**：V/G/C/L/T/E 分类与 ETCLOVG 框架对齐，是项目验收报告的核心。
4. **不动 NexusOps 相关测试**：未受 podcast 重构影响。
5. **不补 ai-content-factory 单测**（除非用户要求）：当前 ai-content-factory 的覆盖由 scenarios E1-E3 + e2e 提供，单测层级暂不缺失。

## 18.6 风险与回滚

- 每步独立 commit，失败时 `git revert <commit>` 单步回滚。
- 步骤 2 重录若 LLM 网络不稳，可跳过本步、把 E2 暂时标记 `skip`，其余步骤照常推进。
- 步骤 6 子目录化若引起 import 路径大面积错误，可整体 `git revert` 回扁平结构。

## 18.7 待用户确认的决策点

| 决策 | 选项 | 推荐 |
|------|------|------|
| **D1**：是否执行 §18.3.2 删除 A 级 3 个测试？ | (a) 全删 / (b) 保留 test-p4-planner 作 planner 模块回归（去掉 podcast 耦合部分） | (a) 全删 —— planner 模块仍有 test-p7-llm-router 覆盖 |
| **D2**：是否执行 §18.3.1 子目录化（core/agent/sdk/apps）？ | (a) 子目录化 / (b) 保持扁平 | (a) 子目录化 —— 34 文件扁平已难导航 |
| **D3**：是否执行 §18.3.4 重录 fixtures？ | (a) 现在重录 / (b) 把 E2 暂时 skip / (c) 删除空 fixture 但不重录（scenarios E2 也删除） | (a) —— fixture 是 scenarios 离线报告的关键依赖 |
| **D4**：是否执行可选重命名（podcast-→aicf-）？ | (a) 重命名 / (b) 保留 podcast 前缀（harness 函数名/fixture 文件名） | (b) —— 收益低、改动面大、易引入拼写错误 |
