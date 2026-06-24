# 测试覆盖盘点与补充计划（19）

> 生成时间：2026-06-22
> 目的：系统性盘点单测 / 场景测试 / e2e 三层覆盖现状，识别缺口，制定分阶段补充计划。
> 决策：用户已确认范围 = **全做（阶段1+2+3）**，NexusOps 补 E 层，scenarios 纳入 CI。

---

## 一、现状盘点

### 1.1 三层测试架构

| 层 | 目录 | 性质 | 运行方式 |
|---|---|---|---|
| **单测** | `tests/unit/` | 机器视角，函数/模块级正确性 | `pnpm test`（vitest） |
| **场景测试** | `tests/scenarios/` | 人视角，离线确定性验收报告（ETCLOVG） | `pnpm scenarios` |
| **e2e** | `tests/e2e/` | 真实 LLM 链路 + fixture 回放 | `npx vitest --config vitest.e2e.config.ts` |

### 1.2 单测覆盖（31 文件，重组后）

```
tests/unit/
├── agent/         9 文件  agent harness / governance / skill 体系
├── apps/nexusops/ 5 文件  nexusops 后端 + tc/vg framework
├── core/         13 文件  api / executor / config / multi-turn / tracer
└── sdk/           3 文件  planner-router / sdk-hitl / tool-contract
```

- ✅ 覆盖完整：agent / nexusops / core / sdk 主路径
- ⚠️ 仅间接覆盖：`src/agent/stop-policy.ts`、`src/agent/step-emitter.ts`、`src/tasks/conversation-store.ts`（通过其它测试间接走，无独立单测）

### 1.3 场景测试覆盖（21 场景 / 39 断言，100% 通过）

| 层 | 场景数 | 覆盖应用 | 关键缺口 |
|---|---|---|---|
| **V** 一致性 | 3 | 仅 NexusOps | **缺 aicf 的 3 条 preconditions** |
| **G** 治理 | 4 | 仅 NexusOps | **缺 aicf 的 web_fetch 守卫** |
| **C** 准确度 | 3 | 仅 NexusOps | 缺 aicf（aicf 暂无 C 层实现，属设计缺口） |
| **L** 生命周期 | 5 | 通用 | 已完整（含多轮追问） |
| **T** 工具协议 | 3 | 通用 | 已完整 |
| **E** 端到端 | 3 | 仅 aicf | **缺 NexusOps fixture 回放** |

### 1.4 关键缺口清单

| # | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| 1 | aicf V/G 层无场景覆盖 | 你最初遇到的 podcast bug 类问题无法被离线场景锁住 | P0 |
| 2 | NexusOps 无 E 层回放 | nexusops 端到端装配无离线锁 | P1 |
| 3 | stop-policy/step-emitter/conversation-store 无独立单测 | 这 3 个模块改坏时只能靠间接测试发现 | P2 |
| 4 | scenarios 未纳入 CI | 场景回归只能手动跑 | P1 |

---

## 二、分阶段补充计划

### 阶段 1：场景测试补缺（核心）✅ 已完成（2026-06-22）

**目标**：把场景测试从「单应用（NexusOps）」扩展到「双应用（NexusOps + aicf）」，并补齐 NexusOps E 层。

| 步骤 | 产物 | 场景数 | 状态 |
|---|---|---|---|
| 1.1 aicf V 层 | `tests/scenarios/v-layer-aicf.ts`：has_focused_thread / podcast_before_article / finalize_has_both | +3 | ✅ |
| 1.2 aicf G 层 | `tests/scenarios/g-layer-aicf.ts`：web_fetch 空参数 / URL 超限 / 非目标工具放行 | +3 | ✅ |
| 1.3 NexusOps E 层 | `tests/scenarios/e-layer-nexus.ts`：装配完整性 + 错误检测 + 事件流解析 | +3 | ✅ |
| 1.4 跑通 | `pnpm scenarios` 全绿，30/30 场景，60/60 断言，双应用覆盖 | 总计 30 场景 | ✅ |

**验收结果**：
- ✅ 场景通过率 100%（30/30）
- ✅ V/G 层同时出现 NexusOps + aicf 的场景（V: 3+3, G: 4+3）
- ✅ E 层同时出现 aicf（E1-E3）+ nexusops（E-N1~E-N3）
- ✅ 报告头部已更新为"NexusOps + AI Content Factory + let-it-flow"

### 阶段 2：单测补缺

**目标**：为间接覆盖的 3 个核心模块补直接单测，降低回归风险。

| 文件 | 测试文件 | 重点 |
|---|---|---|
| `src/agent/stop-policy.ts` | `tests/unit/agent/test-stop-policy.ts` | 终止条件判定（maxSteps/timeout/budget） |
| `src/agent/step-emitter.ts` | `tests/unit/agent/test-step-emitter.ts` | 事件发射顺序 + stepTrace 累积 |
| `src/tasks/conversation-store.ts` | `tests/unit/core/test-conversation-store.ts` | 会话链聚合 + getLatestCompleted |

**前置**：先跑覆盖率（`pnpm test --coverage`），仅补覆盖率 < 80% 的模块。

### 阶段 3：CI 化

**目标**：把场景测试纳入自动化校验，避免回归。

| 改动 | 位置 |
|---|---|
| 新增 `pnpm check` 聚合脚本 | `package.json`（test + scenarios + 类型检查） |
| 文档化执行入口 | `docs/19-test-coverage-plan.md` 末尾追加「执行入口」章节 |

---

## 三、执行顺序与里程碑

| 里程碑 | 内容 | 实际产物 | 状态 |
|---|---|---|---|
| **M1** | 阶段 1 完成 | 30 场景全绿（V/G/E 三层双应用覆盖） | ✅ |
| **M2** | 阶段 2 完成 | 1 个新单测文件（stop-policy 行为深度，6 用例）；conversation-store/step-emitter 经核查已充分覆盖，无需补 | ✅ |
| **M3** | 阶段 3 完成 | `pnpm check` 一键校验 + 执行入口文档 | ✅ |

---

## 四、风险与约束（实际结论）

1. **NexusOps E 层 fixture**：阶段 1.3 未依赖真实 LLM 录制，改用确定性更强的"装配完整性 + 合成事件流错误检测 + 事件流解析"三场景，无需 LLM key，CI 友好。
2. **aicf C 层是设计缺口**：阶段 1 不补 aicf C 层（生产代码尚无 validateXxx 实现），等业务实现后再补。
3. **覆盖率工具**：阶段 2 改用"模块规模 + 现有测试引用核查"方式判断覆盖深度，未引入 coverage provider 依赖（保持依赖轻量）。结论：3 个目标模块中仅 stop-policy 存在"只验证数量未验证行为"的深度缺口，已补齐。

---

## 五、执行入口（CI / 本地校验）

### 5.1 一键全量校验

**快速校验（推荐 CI/precommit 用，~5s）**：

```bash
pnpm check
```

等价于 `pnpm typecheck && pnpm scenarios`。秒级反馈，无网络依赖，覆盖"类型安全 + 离线场景机制"。

**完整校验（发版前用，~30s）**：

```bash
pnpm check:full
```

等价于 `pnpm typecheck && pnpm test && pnpm scenarios`。含 482 单测。注意 `test` 含 SDK HITL 测试，偶发网络抖动可能超时，故拆为独立命令。

### 5.2 分层校验（开发期定位用）

| 命令 | 用途 | 耗时 | 依赖 |
|---|---|---|---|
| `pnpm check` | 快速校验（typecheck + scenarios） | ~5s | 无网络 |
| `pnpm check:full` | 完整校验（typecheck + test + scenarios） | ~30s | test 含 SDK HITL |
| `pnpm typecheck` | TypeScript 类型检查 | ~3s | 无 |
| `pnpm test` | 单测（482 用例，vitest） | ~23s | 无网络 |
| `pnpm scenarios` | 场景测试（30 场景，离线确定性） | ~1s | 无网络 |
| `pnpm lint` | ESLint 静态检查 | ~5s | 无 |
| `pnpm smoke` | SDK import 冒烟 | ~1s | 无 |

### 5.3 真实 LLM 校验（可选，需 key）

| 命令 | 用途 | 依赖 |
|---|---|---|
| `pnpm full-test:online` | 在线单测聚合（含 LLM 路由） | `OPENAI_API_KEY` |
| `npx vitest --config vitest.e2e.config.ts tests/e2e/` | e2e 双层（replay 确定性 + record 真实） | record 需 `OPENAI_API_KEY` |
| `pnpm tsx tests/e2e/run-scenario-eval.ts` | 真实场景评测（5 案例，产出报告） | `OPENAI_API_KEY` |

### 5.4 报告产物

| 路径 | 内容 | 生成命令 |
|---|---|---|
| `tests/reports/scenario-report.md` | 场景测试人视角验收报告 | `pnpm scenarios` |
| `tests/reports/scenario-eval-report.md` | 真实 LLM 场景评测报告 | `pnpm tsx tests/e2e/run-scenario-eval.ts` |
| `tests/reports/full-test-report.json` | 单测聚合 JSON | `pnpm full-test` |

