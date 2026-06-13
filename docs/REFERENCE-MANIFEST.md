# REFERENCE-MANIFEST - LitPilot 设计蓝本清单

> **定位声明**：`reference/` 目录包含从 LitPilot 打包的 38 个 Python 参考文件。在 let-it-flow 切换到 TypeScript 技术栈后，这些文件**仅作为设计理念参照**，**不复用代码**。开发时逐文件对照阅读设计思路，用 TS 原生重新实现。

## 统计

- 文件总数：38
- 源项目：LitPilot（`/Users/admin/work/LitPilot`，Python）
- 用途：let-it-flow 开发的**设计理念对照蓝本**（只读，不参与构建）

## 对照使用方式

| 阅读方式 | 目的 |
|---------|------|
| 对照 `reference/llm/http_client.py` | 理解"进程级共享连接池"理念 → 用 undici Agent 实现 |
| 对照 `reference/tasks/task_registry_reference.py` | 理解"流式合并 + 抢占式领取"理念 → 用 TS async generator 实现 |
| 对照 `reference/planner/workflow_graph_reference.py` | 理解"DAG schema"理念 → 用 Zod 重写为动态生成 |
| 对照 `reference/tools/providers/native_fetch.py` | 理解"五段降级抓取"理念 → 用 TS fetch 重写 |

## 完整文件清单

### LLM 抽象层（6 文件）→ 设计参考

let-it-flow 不直接复用，改用 **Vercel AI SDK v6** 的 provider 抽象（`@ai-sdk/openai` 等）+ AI Gateway 路由。

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/llm/base.py](../reference/llm/base.py) | `backend/app/llm/base.py` | 流式接口设计（AI SDK 已覆盖） |
| [reference/llm/factory.py](../reference/llm/factory.py) | `backend/app/llm/factory.py` | provider 注册表理念 |
| [reference/llm/openai_llm.py](../reference/llm/openai_llm.py) | `backend/app/llm/openai_llm.py` | OpenAI 兼容实现（AI SDK 已覆盖） |
| [reference/llm/minimax_cn_llm.py](../reference/llm/minimax_cn_llm.py) | `backend/app/llm/minimax_cn_llm.py` | 自有协议适配思路 |
| [reference/llm/ollama_llm.py](../reference/llm/ollama_llm.py) | `backend/app/llm/ollama_llm.py` | 本地模型适配思路 |
| [reference/llm/http_client.py](../reference/llm/http_client.py) | `backend/app/llm/http_client.py` | **进程级共享连接池**（重点借鉴） |

### 工具层（7 文件 + 8 provider）→ 设计参考

let-it-flow 用 TS 重写工具层，参考其 provider 路由与降级理念。

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/tools/web_providers.py](../reference/tools/web_providers.py) | `backend/app/agents/tools/web_providers.py` | web_search/web_fetch 统一入口设计 |
| [reference/tools/cached_tools.py](../reference/tools/cached_tools.py) | `backend/app/agents/tools/cached_tools.py` | TTL 缓存层理念 |
| [reference/tools/search_hits.py](../reference/tools/search_hits.py) | `backend/app/agents/tools/search_hits.py` | 搜索结果规整与过滤 |
| [reference/tools/pdf_text.py](../reference/tools/pdf_text.py) | `backend/app/agents/tools/pdf_text.py` | PDF 文本提取后端选择 |
| [reference/tools/metadata_fetch.py](../reference/tools/metadata_fetch.py) | `backend/app/agents/tools/metadata_fetch.py` | 元数据兜底抓取 + junk 检测 |
| [reference/tools/web_search_domains.py](../reference/tools/web_search_domains.py) | `backend/app/agents/tools/web_search_domains.py` | 学术/通用域名配置 |
| [reference/tools/source_resolve.py](../reference/tools/source_resolve.py) | `backend/app/agents/tools/source_resolve.py` | 来源解析工具 |
| [reference/tools/providers/tavily.py](../reference/tools/providers/tavily.py) | `.../providers/tavily.py` | Tavily 搜索 provider |
| [reference/tools/providers/brave.py](../reference/tools/providers/brave.py) | `.../providers/brave.py` | Brave 搜索 provider |
| [reference/tools/providers/openalex.py](../reference/tools/providers/openalex.py) | `.../providers/openalex.py` | OpenAlex 学术搜索 |
| [reference/tools/providers/native_search.py](../reference/tools/providers/native_search.py) | `.../providers/native_search.py` | DuckDuckGo HTML 搜索 |
| [reference/tools/providers/native_fetch.py](../reference/tools/providers/native_fetch.py) | `.../providers/native_fetch.py` | **五段降级抓取**（重点借鉴） |
| [reference/tools/providers/multi_academic.py](../reference/tools/providers/multi_academic.py) | `.../providers/multi_academic.py` | 多源学术并行检索 |
| [reference/tools/providers/jina.py](../reference/tools/providers/jina.py) | `.../providers/jina.py` | Jina Reader 抓取 |
| [reference/tools/capabilities_reference.py](../reference/tools/capabilities_reference.py) | `backend/app/agents/agent_skills.py` | 能力声明结构蓝本 |

### 核心流式层（6 文件）→ 设计参考

let-it-flow 的 SSE 协议保留 v1.0 设计，用 TS 重写实现。

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/core/streaming.py](../reference/core/streaming.py) | `backend/app/core/streaming.py` | **SSE v1.0 协议**（重点借鉴） |
| [reference/core/stream_events.py](../reference/core/stream_events.py) | `backend/app/core/stream_events.py` | 事件构造 helper |
| [reference/core/think_stream.py](../reference/core/think_stream.py) | `backend/app/core/think_stream.py` | 思考链流式处理 |
| [reference/core/config.py](../reference/core/config.py) | `backend/app/core/config.py` | 配置管理思路 |
| [reference/core/response.py](../reference/core/response.py) | `backend/app/core/response.py` | ok()/err() 统一响应 |
| [reference/core/deploy_defaults.py](../reference/core/deploy_defaults.py) | `backend/app/core/deploy_defaults.py` | 部署默认值加载 |

### 任务层（2 文件）→ 设计参考

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/tasks/task_store.py](../reference/tasks/task_store.py) | `backend/app/tasks/task_store.py` | **TaskStore ABC + 抢占式领取**（重点借鉴） |
| [reference/tasks/task_registry_reference.py](../reference/tasks/task_registry_reference.py) | `backend/app/tasks/literature_tasks.py` | **runner + iterStream + coalescer + sweeper**（重点借鉴） |

### 存储层（4 文件）→ 设计参考

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/storage/backend.py](../reference/storage/backend.py) | `backend/app/storage/backend.py` | 存储后端切换理念 |
| [reference/storage/file_store.py](../reference/storage/file_store.py) | `backend/app/storage/file_store.py` | FileStore 实现（精简为 task+artifact） |
| [reference/storage/runtime_settings.py](../reference/storage/runtime_settings.py) | `backend/app/storage/runtime_settings.py` | 运行时设置 |
| [reference/storage/storage_settings.py](../reference/storage/storage_settings.py) | `backend/app/storage/storage_settings.py` | 存储设置 |

### API 层（1 文件）→ 设计参考

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/api/tasks.py](../reference/api/tasks.py) | `backend/app/api/tasks.py` | SSE 端点设计（POST 创建 + GET stream） |

### 规划器蓝本（1 文件）→ 设计参考

| 参考文件 | LitPilot 源 | 可借鉴理念 |
|---------|------------|------|
| [reference/planner/workflow_graph_reference.py](../reference/planner/workflow_graph_reference.py) | `backend/app/agents/workflow_graph.py` | **DAG schema 蓝本**（静态构建→动态生成，重点借鉴） |

### 配置参考（2 文件）

| 参考文件 | LitPilot 源 | 用途 |
|---------|------------|------|
| [reference/pyproject.reference.toml](../reference/pyproject.reference.toml) | `backend/pyproject.toml` | 依赖参考（TS 化后对应 package.json） |
| [reference/deploy.defaults.reference.json](../reference/deploy.defaults.reference.json) | `backend/config/deploy.defaults.json` | 能力/实例绑定配置参考 |

## 相关文档

- [10-litpilot-migration-guide.md](10-litpilot-migration-guide.md) - LitPilot 关系说明（设计参考声明）
- [02-architecture.md](02-architecture.md) - 目标架构（TS）
