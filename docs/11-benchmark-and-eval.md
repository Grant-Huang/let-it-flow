# 11 - 自动化评测基准线（Benchmark & Quality Control）

为了防止 Planner 的 Prompt 劣化、为模型选型提供客观依据，项目内置一套自动化断言评测集。本规范采纳自详细设计文档 §5，并在 TS 生态下落地。

## 11.1 设计目标

- **防回归**：每次修改 planner prompt / few-shot / 模型后，自动跑评测，分数下降则 CI 失败
- **模型选型依据**：横向对比不同模型（gpt-4o / deepseek / claude 等）在意图到 DAG 转换上的表现
- **断言而非人工**：用结构化断言（ground truth）替代主观打分，可在 CI 中无人值守运行
- **不执行真实副作用**：评测只检验 planner 产出的 DAG 质量（语法/工具选择/依赖逻辑），不执行 web_search/web_fetch 等真实调用

## 11.2 评测用例结构

每个用例定义一个意图及其期望的 DAG 特征（ground truth）。

```typescript
// eval/cases/case-schema.ts
import { z } from "zod";

/** 单条期望依赖断言：子节点应依赖某些候选节点之一 */
export const ExpectedDependency = z.object({
  child: z.string().describe("子节点引用的工具名或节点 kind"),
  dependsOnAny: z.array(z.string()).describe("候选前置工具名列表，命中其一即得分"),
});

export const EvalCase = z.object({
  id: z.string().describe("用例唯一 id，如 case_023"),
  category: z.string().describe("用例分类，见 §11.3"),
  intent: z.string().describe("自然语言意图，喂给 planner"),
  config: z.record(z.string(), z.unknown()).default({})
    .describe("workflow config（如是否提供 knowledgeBase）"),
  groundTruth: z.object({
    requiredTools: z.array(z.string()).describe("DAG 必须包含的工具"),
    forbiddenTools: z.array(z.string()).default([]).describe("DAG 必须排除的工具"),
    minTasksCount: z.number().int().positive(),
    maxTasksCount: z.number().int().positive(),
    expectedDependencies: z.array(ExpectedDependency).default([]),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;
```

### 用例 JSON 示例

```json
{
  "id": "case_023",
  "category": "cross_domain_dependency",
  "intent": "分析 Nvidia 财报并对比我 Obsidian 里的行业笔记，生成一段播客脚本",
  "config": {
    "knowledgeBase": { "endpoint": "http://127.0.0.1:7878" }
  },
  "groundTruth": {
    "requiredTools": ["web_search", "knowledge_base", "llm"],
    "forbiddenTools": ["tts"],
    "minTasksCount": 3,
    "maxTasksCount": 5,
    "expectedDependencies": [
      { "child": "llm", "dependsOnAny": ["web_search", "knowledge_base"] }
    ]
  }
}
```

> 说明：`requiredTools`/`forbiddenTools`/`dependsOnAny` 引用的是工具的 **kind**（`web_search`/`knowledge_base`/`llm` 等）而非具体工具 name，这样断言与工具分层解耦，更稳健。

## 11.3 用例分类（覆盖矩阵）

50 个用例按以下分类均衡分布，确保评测覆盖各类规划难点：

| 分类 | 数量 | 考察点 | 示例意图 |
|------|------|--------|---------|
| `simple_research` | 8 | 单一检索→整合链路 | "分析宁德时代的行业地位" |
| `cross_domain_dependency` | 8 | 跨域工具协同（web+kb） | "对比 Nvidia 财报与我本地笔记" |
| `content_generation` | 8 | 生成类（含可选自定义工具） | "制作一期播客" |
| `knowledge_only_qa` | 7 | 纯知识库问答 | "我的笔记里有哪些 Transformer 笔记" |
| `multi_angle_search` | 6 | 多角度并行检索 | "从财务/技术/竞争三个角度分析比亚迪" |
| `forbidden_tool` | 6 | 应正确排除不相关工具 | "总结这篇文章"（不应调 TTS） |
| `dependency_depth` | 4 | 多层依赖链 | 抓取→清洗→生成→交付的长链路 |
| `edge_case` | 3 | 边界情况（空意图/超长/歧义） | 鲁棒性测试 |

## 11.4 自动化评分权重矩阵（100 分制）

评分系统采用 100 分制，由断言引擎在 CI 中自动运行：

| 评估维度 | 分值 | 断言校验内容 |
|---------|------|-------------|
| **语法与合法性 (Syntax)** | **40 分** | · Zod schema 校验成功，DAG 结构合法 (20 分)<br>· 图拓扑结构闭环，无死循环/死锁（拓扑排序可完成）(20 分) |
| **工具选择准确性 (Tools)** | **30 分** | · 包含所有必要工具 `requiredTools` (15 分)<br>· 成功拦截禁用工具 `forbiddenTools` (15 分) |
| **数据流与逻辑 (Logic)** | **30 分** | · 拓扑依赖符合预期 `expectedDependencies` (20 分)<br>· JSONPath 语法合法且引用节点均为前驱 (10 分) |

### 评分规则细节

- **部分得分**：`requiredTools` 按"包含比例"给分（如 3 个必要工具命中 2 个，得 `15 * 2/3 = 10` 分）。`expectedDependencies` 同理按命中比例。
- **零分项**：Zod 校验失败（语法维度的前 20 分）直接判 0，后续维度仍独立评分（便于定位问题）。
- **用例总分**：单用例满分 100。整个评测集的分数 = 所有用例的算术平均。

### 质量阈值

| 总分区间 | 含义 | CI 行为 |
|---------|------|---------|
| ≥ 85 | 通过 | 绿色 |
| 70 - 84 | 警告 | 黄色（允许合并，但需 review） |
| < 70 | 失败 | 红色（CI 失败，禁止合并） |

## 11.5 断言引擎（Runner）

```typescript
// eval/runner.ts
import { WorkflowDAG } from "../src/planner/dag-schema";
import type { EvalCase } from "./cases/case-schema";
import { validateDag } from "../src/planner/validator";

export interface CaseScore {
  caseId: string;
  total: number;          // 0-100
  breakdown: {
    syntax: number;       // 0-40
    tools: number;        // 0-30
    logic: number;        // 0-30
  };
  details: string[];      // 失败断言的可读说明
}

export async function scoreCase(
  dagJson: unknown,
  testCase: EvalCase,
): Promise<CaseScore> {
  const details: string[] = [];

  // === 维度1: 语法与合法性 (40分) ===
  let syntax = 0;
  const parseResult = WorkflowDAG.safeParse(dagJson);
  if (parseResult.success) {
    syntax += 20; // Zod 校验成功
    const errors = validateDag(parseResult.data, registry);
    if (errors.length === 0) syntax += 20; // 拓扑/结构校验通过
    else details.push(`拓扑/结构错误: ${errors.join("; ")}`);
  } else {
    details.push(`Zod 校验失败: ${parseResult.error.message}`);
  }

  // 仅在解析成功时继续工具/逻辑评分
  let tools = 0;
  let logic = 0;
  if (parseResult.success) {
    const dag = parseResult.data;
    const taskKinds = dag.tasks.map((t) => t.kind);

    // === 维度2: 工具选择准确性 (30分) ===
    const required = testCase.groundTruth.requiredTools;
    const hitRequired = required.filter((r) => taskKinds.includes(r));
    tools += Math.round((15 * hitRequired.length) / Math.max(required.length, 1));
    if (hitRequired.length < required.length) {
      details.push(`缺少必要工具: ${required.filter((r) => !hitRequired.includes(r))}`);
    }

    const forbidden = testCase.groundTruth.forbiddenTools;
    const hitForbidden = forbidden.filter((f) => taskKinds.includes(f));
    tools += 15 - Math.round((15 * hitForbidden.length) / Math.max(forbidden.length, 1));
    if (hitForbidden.length > 0) {
      details.push(`误用禁用工具: ${hitForbidden}`);
    }

    // === 维度3: 数据流与逻辑 (30分) ===
    const deps = testCase.groundTruth.expectedDependencies;
    const hitDeps = deps.filter((dep) => {
      const childNode = dag.tasks.find((t) =>
        t.kind === dep.child || t.toolName === dep.child);
      if (!childNode) return false;
      const childPreds = dag.edges
        .filter((e) => e.target === childNode.id)
        .map((e) => dag.tasks.find((t) => t.id === e.source)?.kind)
        .filter(Boolean);
      return dep.dependsOnAny.some((d) => childPreds.includes(d));
    });
    logic += Math.round((20 * hitDeps.length) / Math.max(deps.length, 1));
    if (hitDeps.length < deps.length) {
      details.push(`依赖断言未满足: ${deps.length - hitDeps.length} 项`);
    }

    // JSONPath 引用合法性（10分）
    const allRefsValid = dag.tasks.every((t) =>
      t.inputRefs.every((ref) =>
        ref.startsWith("$.") && /\$\.tasks\.[^.]+\.output/.test(ref) || ref.startsWith("$.variables.")
      )
    );
    if (allRefsValid) logic += 10;
    else details.push("存在非法 JSONPath 引用");
  }

  return {
    caseId: testCase.id,
    total: syntax + tools + logic,
    breakdown: { syntax, tools, logic },
    details,
  };
}
```

## 11.6 评测集执行入口

```typescript
// eval/run-all.ts
import { glob } from "node:fs/promises";
import { plan } from "../src/planner/planner";
import { scoreCase, type CaseScore } from "./runner";
import type { EvalCase } from "./cases/case-schema";

async function loadCases(): Promise<EvalCase[]> {
  const files = await Array.fromAsync(glob("eval/cases/*.json"));
  return Promise.all(
    files.map(async (f) =>
      EvalCase.parse(JSON.parse(await readFile(f, "utf8")))),
  );
}

export async function runBenchmark(): Promise<{
  average: number;
  results: CaseScore[];
}> {
  const cases = await loadCases();
  const results: CaseScore[] = [];

  for (const testCase of cases) {
    // 调用真实 planner（不执行副作用，仅生成 DAG）
    const dag = await plan(testCase.intent, testCase.config);
    const score = await scoreCase(dag, testCase);
    results.push(score);
  }

  const average = results.reduce((s, r) => s + r.total, 0) / results.length;
  return { average, results };
}
```

> **注意**：planner 内部的 LLM 调用需在评测环境用真实模型（非 mock），否则评测无意义。CI 中通过环境变量配置评测用模型与 API Key。

## 11.7 CI 集成

评测作为测试门禁的独立关卡（见 [09-milestones-and-todolist.md](09-milestones-and-todolist.md) §9.1）：

```bash
# scripts/test-gates.sh 新增第 7 关
# 7. Planner 评测基准线（仅对 planner 相关 PR 触发，避免拖慢常规 CI）
pnpm eval --min-score 70
```

GitHub Actions 配置（`.github/workflows/eval.yml`）：

```yaml
name: Planner Eval
on:
  pull_request:
    paths:
      - "src/planner/**"
      - "eval/**"
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Run benchmark
        env:
          AI_GATEWAY_TOKEN: ${{ secrets.AI_GATEWAY_TOKEN }}
          EVAL_MODEL: openai/gpt-4o
        run: pnpm eval --min-score 70 --report eval-report.json
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report
          path: eval-report.json
```

### 报告格式

`eval-report.json` 输出示例：

```json
{
  "model": "openai/gpt-4o",
  "timestamp": "2026-06-13T14:30:00Z",
  "average": 87.4,
  "passed": 47,
  "warned": 2,
  "failed": 1,
  "results": [
    { "caseId": "case_023", "total": 95, "breakdown": { "syntax": 40, "tools": 30, "logic": 25 }, "details": [] },
    { "caseId": "case_007", "total": 55, "breakdown": { "syntax": 40, "tools": 10, "logic": 5 }, "details": ["缺少必要工具: knowledge_base"] }
  ]
}
```

## 11.8 用例维护规范

- 用例文件命名：`eval/cases/case_<编号>_<简述>.json`，如 `case_023_cross_domain.json`
- 用例 JSON 必须通过 `EvalCase` Zod schema 校验才能合入
- 新增/修改用例需在 PR 描述中说明意图（防止用例被改弱以"刷分"）
- 黄金 few-shot（见 [06-planner-and-templates.md](06-planner-and-templates.md)）**不得**与评测用例重叠，否则评测变成"背答案"，失去泛化检验意义

## 11.9 相关文档

- [06-planner-and-templates.md](06-planner-and-templates.md) - 被评测的 planner 实现
- [09-milestones-and-todolist.md](09-milestones-and-todolist.md) - 评测作为 M5 的验收子任务
- [03-dag-schema.md](03-dag-schema.md) - 评分依赖的 DAG schema
