# 03 - WorkflowDAG 规范

WorkflowDAG 是 let-it-flow 的核心数据结构，描述一次工作流的完整执行计划。它由 Planner LLM 生成，经 Validator 校验后交由 Executor 确定性执行。

## 3.1 设计来源

WorkflowDAG 泛化自 LitPilot 的 `workflow_graph.py`（参考 `reference/planner/workflow_graph_reference.py`）。LitPilot 的版本是**静态构建**的（针对文献综述固定流水线），let-it-flow 改为 **LLM 动态生成**，并扩展了变量引用、参数 schema、节点类型、规划思考链。

### 与 LitPilot workflow_graph 的对照

| 维度 | LitPilot workflow_graph.py | let-it-flow dag-schema.ts |
|------|---------------------------|--------------------------|
| 构建方式 | Python 代码硬编码（`build_literature_graph()`） | LLM 动态输出（AI SDK v6 结构化输出） |
| NodeKind | router/search/fetch/llm/deliver/chat（6 种） | web_search/web_fetch/knowledge_base/llm/tool/deliver（6 种） |
| 参数传递 | 无（固定逻辑读 corpus） | `params` + `input_refs`（JSONPath 引用） |
| 校验 | 无 | Validator 校验拓扑/工具/schema |
| 用途 | 仅前端可视化展示 | 前端展示 + 驱动实际执行 |
| 规划可观测 | 无 | `planRationale` 记录规划思考链 |

## 3.2 Zod Schema 定义

```typescript
// src/planner/dag-schema.ts
import { z } from "zod";

export const NodeKind = z.enum([
  "web_search",      // 网络检索
  "web_fetch",       // 网页抓取
  "knowledge_base",  // 本地知识库（HTTP/MCP）
  "llm",             // LLM 生成/整合
  "tool",            // 消费应用自定义工具
  "deliver",         // 产物聚合交付
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const NodeStatus = z.enum(["pending", "active", "done", "skipped", "error"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

/**
 * DAG 中的一个执行节点。
 */
export const WorkflowNode = z.object({
  id: z.string().describe("唯一标识，DAG 内唯一，如 search_industry"),
  kind: NodeKind,
  label: z.string().describe("人类可读标签（用于 UI 展示）"),
  toolName: z.string().nullish().describe("kind=llm/tool 时，指定具体工具/角色"),
  params: z.record(z.string(), z.unknown()).default({})
    .describe("静态参数（不依赖上游输出）；字符串值可含 JSONPath 占位符"),
  inputRefs: z.array(z.string()).default([])
    .describe("依赖的上游节点输出引用，采用 JSONPath 语法，如 $.tasks.search_1.output.results"),
  description: z.string().default("").describe("节点说明（planner 填写）"),
  requireConfirmation: z.boolean().default(false)
    .describe("HITL：节点执行后是否暂停等待人工确认（见 12-hitl-and-control.md）"),
  contentPipeline: ContentPipelineConfig.default({})
    .describe("数据清洗管道：控制上游输出注入本节点前的压缩策略（见 07-executor.md §7.6）"),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/**
 * 数据清洗管道配置：解决 web_fetch 等大输出节点撑爆下游 LLM 上下文的问题。
 * 三阶段 strip→summarize→truncate，成本递增，默认只开 strip+truncate（免费、确定性）。
 */
export const ContentPipelineConfig = z.object({
  maxTokens: z.number().int().positive().default(4000)
    .describe("硬兜底截断阈值（token 数）。阶段3 永远按此截断，防 400"),
  strip: z.boolean().default(true)
    .describe("阶段1：HTML/Markdown 结构净化（去 img/样式/脚本，保留标题表格正文）。默认开"),
  summarize: z.boolean().default(false)
    .describe("阶段2：意图感知滚动摘要（调小快模型按 DAG intent 抽取核心事实）。付费，默认关"),
  summarizeModel: z.string().optional()
    .describe("summarize 阶段用的小快模型（如 gpt-4o-mini / qwen-1.5b）；缺省用 plannerModel"),
  fields: z.array(z.string()).optional()
    .describe("白名单：仅清洗指定字段（如 web_fetch 的 [\"content\"]）。缺省对自由文本字符串触发，结构化对象/数组透传"),
});

/**
 * DAG 边，表示执行依赖（source 完成后 target 才能执行）。
 */
export const WorkflowEdge = z.object({
  source: z.string(),
  target: z.string(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

/**
 * 完整的工作流图。
 */
export const WorkflowDAG = z.object({
  id: z.string().describe("DAG 唯一 id（与 task_id 对应）"),
  intent: z.string().describe("原始用户意图"),
  planRationale: z.string()
    .describe("规划链路的思考逻辑，用于可观测/调试；不参与执行"),
  templateId: z.string().nullish().describe("来源模板（research/content/qa/...）"),
  variables: z.record(z.string(), z.unknown()).default({})
    .describe("模板变量（LLM 填充结果，供节点通过 $.variables.xxx 引用）"),
  tasks: z.array(WorkflowNode).describe("按执行计划排列的节点列表"),
  edges: z.array(WorkflowEdge).describe("执行依赖边列表"),
  requirePlanConfirmation: z.boolean().default(false)
    .describe("HITL：规划完成后是否暂停等待人工确认整个 DAG（见 12-hitl-and-control.md）"),
  onNodeError: z.enum(["abort", "skip", "retry"]).default("abort")
    .describe("节点失败策略：abort 中止全图 / skip 跳过用空值继续 / retry 有限次重试（见 07-executor.md §7.4）"),
  retryAttempts: z.number().int().positive().default(2)
    .describe("onNodeError=retry 时的最大重试次数"),
});
export type WorkflowDAG = z.infer<typeof WorkflowDAG>;
```

> **设计说明**：
> - 顶层用扁平的 `tasks` + `edges`（而非嵌套层级），与 AI SDK 结构化输出的 schema 推断更契合，planner 输出更稳定。
> - 字段命名统一 `camelCase`（符合 JS/TS 约定）；线协议 JSON 传输时也用 camelCase，消费端无需额外转换层。
> - `planRationale` 采纳自详细设计文档，用于记录 planner 的思考链，便于评测与调试，不参与执行逻辑。

## 3.3 节点类型详解

### web_search

网络检索节点。调用内置 `builtin/web_search` 工具。

```json
{
  "id": "search_overview",
  "kind": "web_search",
  "label": "搜索行业概览",
  "params": {
    "query": "宁德时代 新能源电池 行业地位 2024",
    "provider": "tavily",
    "maxResults": 8
  }
}
```

**输出**：`{ results: [{url, title, snippet}] }`，可通过 `$.tasks.search_overview.output.results` 引用。

### web_fetch

网页抓取节点。调用内置 `builtin/web_fetch` 工具。

```json
{
  "id": "fetch_reports",
  "kind": "web_fetch",
  "label": "抓取研报全文",
  "inputRefs": ["$.tasks.search_overview.output.results"],
  "params": {
    "urlField": "url",
    "provider": "native",
    "maxConcurrent": 4
  }
}
```

**说明**：`inputRefs` 通过 JSONPath 引用上游 search 节点的 `output.results`，`params.urlField` 指定从每个结果对象中取哪个字段作为 URL。**输出**：`{ contents: [{url, text, error?}] }`。

### knowledge_base

本地知识库检索节点。通过 HTTP/MCP 调用消费应用提供的知识库服务。

```json
{
  "id": "kb_local",
  "kind": "knowledge_base",
  "label": "检索本地笔记",
  "params": {
    "endpoint": "http://127.0.0.1:7878",
    "action": "search",
    "query": "电池技术 笔记",
    "topK": 10
  }
}
```

**输出**：`{ items: [{id, title, content, score}] }`。详见 [05-kb-mcp-protocol.md](05-kb-mcp-protocol.md)。

### llm

LLM 生成/整合节点。把上游节点的内容拼接为 context，由 LLM 流式生成。

```json
{
  "id": "llm_integrate",
  "kind": "llm",
  "label": "整合分析报告",
  "toolName": "integrator",
  "inputRefs": [
    "$.tasks.fetch_reports.output.contents",
    "$.tasks.kb_local.output.items"
  ],
  "params": {
    "systemPrompt": "你是新能源行业分析师，基于以下资料撰写结构化分析报告...",
    "maxTokens": 4096,
    "temperature": 0.3
  }
}
```

**说明**：`toolName` 指定 LLM 角色（对应 `src/services/llm-service.ts` 中的角色注入），`inputRefs` 的内容会按顺序拼接到 user message。**输出**：流式 text（通过 SSE 实时推送）+ 最终 `{ text: string }`。

### tool

消费应用自定义工具节点。调用消费应用注册到平台的自定义工具。

```json
{
  "id": "tts_podcast",
  "kind": "tool",
  "label": "文本转语音",
  "toolName": "podcast_tts",
  "inputRefs": ["$.tasks.llm_script.output.text"],
  "params": {
    "voice": "narrator",
    "speed": 1.0
  }
}
```

**说明**：自定义工具由消费应用按 Tool 接口实现并通过 API 注册。**输出**：由工具定义的 outputSchema 决定。

### deliver

产物聚合交付节点。每个 DAG 的终点。

```json
{
  "id": "deliver_report",
  "kind": "deliver",
  "label": "交付分析报告",
  "inputRefs": ["$.tasks.llm_integrate.output.text"],
  "params": {
    "artifactId": "analysis_report",
    "format": "markdown"
  }
}
```

**输出**：`{ artifactId, content, format }`，会触发 `artifact` 类型 SSE 事件。

## 3.4 变量引用语法（JSONPath）

节点间数据传递通过 `inputRefs` 与 `params` 中的 JSONPath 表达式实现。Executor 在执行某节点前，解析其引用：

| 表达式 | 含义 |
|--------|------|
| `$.tasks.search_overview.output.results` | 取 `search_overview` 节点输出的 `results` 字段 |
| `$.tasks.fetch_reports.output.contents` | 取抓取节点的全部内容数组 |
| `$.tasks.llm_integrate.output.text` | 取 LLM 节点的最终文本 |
| `$.variables.topic` | 取 DAG 顶层 `variables` 中 planner 填充的变量 |

**解析规则**：
- 引用必须指向已完成的节点（拓扑序保证）
- 引用不存在的节点/字段时，Validator 报错
- `params` 中的字符串值也可内嵌 JSONPath 片段（会被解析替换）
- 使用 `jsonpath-plus` 库解析（TS 生态成熟实现）

**对比旧 `${}` 语法**：早期设计使用简化版 `${node_id.field}`，已统一升级为标准 JSONPath。理由：(1) 与生态对齐，TS 侧无需自写解析器；(2) 表达力更强（支持过滤表达式、数组下标）；(3) 评测与断言更直观。

## 3.5 完整示例：股票分析

```json
{
  "id": "wf_stock_analysis_001",
  "intent": "分析宁德时代(300750)的新能源电池行业地位",
  "planRationale": "需从行业格局与公司动态两个角度检索，抓取详情后结合内部研究资料，由 LLM 撰写综合分析报告。",
  "templateId": "research",
  "variables": {
    "company": "宁德时代",
    "code": "300750",
    "sector": "新能源电池"
  },
  "tasks": [
    {
      "id": "search_industry",
      "kind": "web_search",
      "label": "搜索行业概览",
      "params": { "query": "$.variables.sector 行业格局 2024", "maxResults": 6 }
    },
    {
      "id": "search_company",
      "kind": "web_search",
      "label": "搜索公司动态",
      "params": { "query": "$.variables.company 财报 产能 技术", "maxResults": 6 }
    },
    {
      "id": "fetch_all",
      "kind": "web_fetch",
      "label": "抓取详情",
      "inputRefs": [
        "$.tasks.search_industry.output.results",
        "$.tasks.search_company.output.results"
      ],
      "params": { "maxConcurrent": 4 }
    },
    {
      "id": "kb_internal",
      "kind": "knowledge_base",
      "label": "检索内部研究",
      "params": {
        "endpoint": "http://127.0.0.1:7878",
        "action": "search",
        "query": "$.variables.company",
        "topK": 5
      }
    },
    {
      "id": "llm_analysis",
      "kind": "llm",
      "label": "撰写分析报告",
      "toolName": "integrator",
      "inputRefs": [
        "$.tasks.fetch_all.output.contents",
        "$.tasks.kb_internal.output.items"
      ],
      "params": { "systemPrompt": "你是新能源行业分析师...", "maxTokens": 4096 }
    },
    {
      "id": "deliver",
      "kind": "deliver",
      "label": "交付报告",
      "inputRefs": ["$.tasks.llm_analysis.output.text"],
      "params": { "artifactId": "stock_analysis", "format": "markdown" }
    }
  ],
  "edges": [
    { "source": "search_industry", "target": "fetch_all" },
    { "source": "search_company", "target": "fetch_all" },
    { "source": "fetch_all", "target": "llm_analysis" },
    { "source": "kb_internal", "target": "llm_analysis" },
    { "source": "llm_analysis", "target": "deliver" }
  ]
}
```

**拓扑分层**：
- Layer 0: `search_industry`, `search_company`, `kb_internal`（并发）
- Layer 1: `fetch_all`（等 Layer 0）
- Layer 2: `llm_analysis`（等 Layer 1）
- Layer 3: `deliver`（等 Layer 2）

## 3.6 完整示例：播客生成

```json
{
  "id": "wf_podcast_001",
  "intent": "根据深度学习优化方向制作一期播客",
  "planRationale": "先检索主题资料与本地笔记，抓取网页后由 LLM 生成两人对话式播客脚本，再经 TTS 工具转为音频。",
  "templateId": "content",
  "variables": {
    "topic": "深度学习优化算法"
  },
  "tasks": [
    {
      "id": "search_topic",
      "kind": "web_search",
      "label": "搜索主题资料",
      "params": { "query": "$.variables.topic 综述 2024", "maxResults": 5 }
    },
    {
      "id": "kb_notes",
      "kind": "knowledge_base",
      "label": "检索本地笔记",
      "params": {
        "endpoint": "http://127.0.0.1:7878",
        "action": "search",
        "query": "$.variables.topic",
        "topK": 8
      }
    },
    {
      "id": "fetch_web",
      "kind": "web_fetch",
      "label": "抓取网页",
      "inputRefs": ["$.tasks.search_topic.output.results"],
      "params": {}
    },
    {
      "id": "llm_script",
      "kind": "llm",
      "label": "生成播客脚本",
      "toolName": "script_writer",
      "inputRefs": [
        "$.tasks.fetch_web.output.contents",
        "$.tasks.kb_notes.output.items"
      ],
      "params": {
        "systemPrompt": "你是播客脚本作家，把资料改写成两人对话式播客脚本...",
        "maxTokens": 8192
      }
    },
    {
      "id": "tts_audio",
      "kind": "tool",
      "label": "文本转语音",
      "toolName": "podcast_tts",
      "inputRefs": ["$.tasks.llm_script.output.text"],
      "params": { "voiceA": "host", "voiceB": "guest" }
    },
    {
      "id": "deliver",
      "kind": "deliver",
      "label": "交付播客",
      "inputRefs": [
        "$.tasks.llm_script.output.text",
        "$.tasks.tts_audio.output.audioUrl"
      ],
      "params": { "artifactId": "podcast_episode", "format": "mixed" }
    }
  ],
  "edges": [
    { "source": "search_topic", "target": "fetch_web" },
    { "source": "fetch_web", "target": "llm_script" },
    { "source": "kb_notes", "target": "llm_script" },
    { "source": "llm_script", "target": "tts_audio" },
    { "source": "tts_audio", "target": "deliver" }
  ]
}
```

## 3.7 Validator 校验规则

DAG 在执行前必须通过以下校验（详见 [06-planner-and-templates.md](06-planner-and-templates.md)）：

1. **结构完整性**：每个 edge 的 source/target 必须指向存在的 node
2. **拓扑无环**：DAG 必须是有向无环图（拓扑排序可完成）
3. **唯一入口性**：至少有一个无前驱的起始节点
4. **deliver 唯一**：有且仅有一个 deliver 节点作为终点
5. **工具存在性**：所有 `toolName` 必须在 ToolRegistry 中已注册
6. **参数 schema**：每个节点的 `params` 符合对应工具的 `inputSchema`
7. **引用合法性**：所有 JSONPath 引用的 node id 必须是前驱节点；`$.variables.*` 引用的键必须存在于顶层 variables

校验失败时，返回详细错误清单，不进入执行。

## 3.8 相关文档

- [04-tool-protocol.md](04-tool-protocol.md) - 工具协议（定义 inputSchema/outputSchema；FlowConnector）
- [06-planner-and-templates.md](06-planner-and-templates.md) - Planner 如何生成 DAG
- [07-executor.md](07-executor.md) - Executor 如何执行 DAG
- [12-hitl-and-control.md](12-hitl-and-control.md) - `requireConfirmation` / `requirePlanConfirmation` 的暂停语义
