# let-it-flow

通用意图驱动的工作流执行平台（Intent-to-DAG Compiler）。接收自然语言意图，由 LLM 规划 DAG 工作流图，平台校验后确定性执行，全程通过流式（SDK async generator 或 SSE）反馈进度与产物。

## 核心范式

**LLM 动态规划 DAG + 平台确定性执行**：LLM 负责把意图拆解为工作流图（哪些节点、什么顺序、什么参数），平台负责按拓扑分层并发执行，每个节点的产出实时推送。提供 SDK（进程内）与 HTTP（薄封装）两种等价消费形态。

```
用户意图 → Planner LLM → WorkflowDAG → Validator → Executor → 流式事件 + 产物
```

## 五类核心能力

| 能力 | 说明 |
|------|------|
| 网络检索（web_search） | 多 provider 并行搜索（Tavily/Brave/native/学术多源） |
| 网页抓取（web_fetch） | 多段降级抓取 |
| 本地知识库（knowledge_base） | 通过 `IKnowledgeProvider` 接口接入（ObsidianProvider 为内置示例；亦支持 HTTP/MCP 远程） |
| LLM 整合（llm） | 把多源内容融合成最终产物（报告/脚本/答案） |
| 自主研究（autonomous_research） | Agent-as-Tool（domain 层），局部受限 ReAct 循环，用于深度调研 |

## 典型场景

- 股票 / 行业分析：web_search → web_fetch → llm 整合 → 分析报告
- 播客制作：web_search + knowledge_base → llm 生成脚本 → TTS
- 学术文献综述（LitPilot 原型）：多源学术搜索 → 全文抓取 → 分章综述
- 竞品调研：web + 内部知识库 → 对比矩阵

## 快速开始

```bash
# 后端（M1 实现后可用）
pnpm install
pnpm dev   # Hono app on :8000

# 提交工作流
curl -X POST http://localhost:8000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{"intent": "分析宁德时代的新能源电池行业地位"}'

# 订阅 SSE 流
curl -N http://localhost:8000/api/tasks/{task_id}/stream
```

或 SDK 形态（进程内）：

```typescript
import { LetItFlow } from "let-it-flow";
const flow = new LetItFlow({ plannerModel: "openai/gpt-4o" });
const stream = await flow.execute("分析宁德时代的新能源电池行业地位");
for await (const chunk of stream) { /* 处理流式事件 */ }
```

## 项目结构

```
let-it-flow/
├── src/              # TS 内核（planner/executor/tools/tasks/sdk/core）
├── frontend/         # 最小演示 UI（待实现）
├── docs/             # 设计文档（13 篇）
├── reference/        # LitPilot 参考代码（设计参照，不复用）
├── examples/         # 示例消费应用（SDK + HTTP 形态）
├── eval/             # 自动化评测基准线
└── scripts/          # 测试门禁脚本
```

## 设计文档

| 文档 | 内容 |
|------|------|
| [docs/01-overview.md](docs/01-overview.md) | 项目定位与核心范式（SDK 为主） |
| [docs/02-architecture.md](docs/02-architecture.md) | 整体架构与 SDK/HTTP 双形态模块边界 |
| [docs/03-dag-schema.md](docs/03-dag-schema.md) | WorkflowDAG 完整规范（含 HITL 字段） |
| [docs/04-tool-protocol.md](docs/04-tool-protocol.md) | FlowConnector 工具协议契约 |
| [docs/05-kb-mcp-protocol.md](docs/05-kb-mcp-protocol.md) | IKnowledgeProvider 与 ObsidianProvider |
| [docs/06-planner-and-templates.md](docs/06-planner-and-templates.md) | 规划器与模板库 |
| [docs/07-executor.md](docs/07-executor.md) | DAG 执行器（含 HITL 暂停点） |
| [docs/08-task-streaming.md](docs/08-task-streaming.md) | 任务与流式机制 |
| [docs/09-milestones-and-todolist.md](docs/09-milestones-and-todolist.md) | 里程碑与 TodoList |
| [docs/10-litpilot-migration-guide.md](docs/10-litpilot-migration-guide.md) | LitPilot 关系（设计参考） |
| [docs/11-benchmark-and-eval.md](docs/11-benchmark-and-eval.md) | 自动化评测体系 |
| [docs/12-hitl-and-control.md](docs/12-hitl-and-control.md) | Human-in-the-loop 流程控制 |
| [docs/REFERENCE-MANIFEST.md](docs/REFERENCE-MANIFEST.md) | 参考代码清单 |

## reference/ 目录

从 LitPilot 打包的 38 个参考文件，**仅作设计理念参照**（项目已切换到 TS 技术栈，不复用 Python 代码）。涵盖：
- LLM 抽象层（6 文件）
- 工具层 + providers（15 文件）
- 核心流式层（6 文件）
- 任务层（2 文件）
- 存储层（4 文件）
- API/规划器蓝本 + 配置参考（5 文件）

详见 [docs/REFERENCE-MANIFEST.md](docs/REFERENCE-MANIFEST.md)。

## 与 LitPilot 的关系

let-it-flow 从 LitPilot 抽象而来。LitPilot 原本是领域特化的文献综述应用，let-it-flow 把它的核心能力（检索/抓取/LLM 整合）泛化为通用平台。**项目已切换到 TypeScript 技术栈，LitPilot 的 Python 代码仅保留作设计参考，不复用**。详见 [docs/10-litpilot-migration-guide.md](docs/10-litpilot-migration-guide.md)。

## 技术栈

- 运行时：Node.js 22 LTS + TypeScript 5.7+（strict）
- Web 框架：Hono 4.x（仅 HTTP 形态）
- LLM：Vercel AI SDK v6（`generateText` + `Output.object` 结构化输出）
- 数据校验：Zod 3.x
- 测试：vitest
- 部署：Vercel（前后端同站）
- 前端：Next.js 15 + React 19（最小演示）

## 开发状态

当前阶段：设计文档完成（13 篇，含 SDK/HITL/评测细化），reference 代码已打包。待实现 M1-M7 里程碑。

详见 [docs/09-milestones-and-todolist.md](docs/09-milestones-and-todolist.md)。
