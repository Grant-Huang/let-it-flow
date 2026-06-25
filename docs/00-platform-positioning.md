# let-it-flow 平台功能定位

**版本**: 1.0  
**日期**: 2026-06-25  
**作者**: Claude + Team  

---

## Executive Summary

let-it-flow 是一个**Intent-to-DAG 编排平台**，专注于：

1. **后端编排框架**: LLM 动态规划工作流 DAG → 平台确定性执行
2. **流式执行引擎**: 全程异步流式反馈（SDK / HTTP 双形态）
3. **工具生态**: web_search / web_fetch / knowledge_base / llm_synthesis 等标准工具
4. **平台能力**: HITL 门禁、任务管理、流式进度、参考实现

---

## 分层定位

```
┌─────────────────────────────────────────────────────────┐
│ Consumers (消费级应用)                                   │
│ ├─ ai-content-factory (播客生成 demo)                   │
│ ├─ nexusops (discovery ops demo)                         │
│ └─ Other custom applications                             │
└──────────────────────┬──────────────────────────────────┘
                       │ (HTTP API / SDK)
┌──────────────────────▼──────────────────────────────────┐
│ let-it-flow Platform (编排框架 + 参考实现)              │
│ ├─ Backend Core:                                        │
│ │  ├─ Planner (LLM: 意图→DAG 规划)                     │
│ │  ├─ Executor (确定性执行 + 流式反馈)                 │
│ │  ├─ Validator (DAG 校验)                            │
│ │  └─ Task Manager (进度 + HITL)                      │
│ │                                                       │
│ ├─ Tool Ecosystem:                                      │
│ │  ├─ web_search (多源搜索)                            │
│ │  ├─ web_fetch (网页降级抓取)                         │
│ │  ├─ knowledge_base (IKnowledgeProvider)              │
│ │  ├─ llm_synthesis (多源融合)                         │
│ │  └─ autonomous_research (Agent-as-Tool)              │
│ │                                                       │
│ ├─ Platform Services:                                   │
│ │  ├─ HTTP API (Hono 薄封装)                          │
│ │  ├─ SDK Interface (进程内 async generator)          │
│ │  ├─ Config Management (模板库 + 参数 binding)       │
│ │  └─ Observability (日志 + 指标)                     │
│ │                                                       │
│ └─ Reference Implementations:                           │
│    ├─ apps/ai-content-factory/                        │
│    ├─ apps/nexusops/                                  │
│    └─ examples/podcast-generator/                     │
└──────────────────────┬──────────────────────────────────┘
                       │ (使用)
┌──────────────────────▼──────────────────────────────────┐
│ @meso.ai Ecosystem (上游库)                             │
│ ├─ @meso.ai/types (通用类型定义)                       │
│ ├─ @meso.ai/ui (通用流式展示组件)                      │
│ └─ @meso.ai/client (LLM 统一客户端)                    │
└─────────────────────────────────────────────────────────┘
```

---

## 核心定位：五层架构

### Layer 1: LLM Planner (规划层)

**职责**: 接收用户意图 → LLM 分析 → 生成 WorkflowDAG

**能力**:
- 多 provider 支持 (OpenAI / Azure / Anthropic / etc.)
- 可配置的系统提示（包含工具库、约束、最佳实践）
- 模板库支持（快速应对常见场景）
- 意图→DAG 的可解释性

**边界**:
- ✅ 规划、建议方案
- ❌ 不执行决策（由用户/HITL确认）

---

### Layer 2: Validator (校验层)

**职责**: 确保 DAG 合法性、可执行性

**能力**:
- 拓扑校验（无环、依赖完整）
- 工具可用性检查
- 参数合理性验证
- 资源额度检查（token / API 调用 / 并发度）

**边界**:
- ✅ 技术合法性检查
- ❌ 不进行业务逻辑判断（由应用层决定）

---

### Layer 3: Executor (执行层)

**职责**: 按 DAG 拓扑执行，全程流式反馈

**能力**:
- 拓扑排序 → 分层并发执行
- 流式事件推送 (Token + ToolCall + TaskProgress)
- HITL 门禁 (Pause & Confirm)
- 错误恢复（重试、降级、回滚）
- 进度追踪（ETA、中间结果）

**边界**:
- ✅ 确定性执行、流式反馈
- ❌ 不做业务决策（仅执行 DAG）

---

### Layer 4: Tool Ecosystem (工具层)

**职责**: 提供标准工具，接入第三方工具

**能力**:

| 工具 | 说明 | 提供方 |
|-----|------|--------|
| web_search | 多源并行搜索（Tavily/Brave/自研/学术） | Platform |
| web_fetch | 多段降级抓取（含反爬虫对抗） | Platform |
| knowledge_base | 通过 IKnowledgeProvider 接入本地/远程KB | Platform |
| llm_synthesis | 多源内容融合（文本总结、对比、推理） | Platform |
| autonomous_research | Agent-as-Tool（受限 ReAct 循环） | Platform |
| Custom Tools | 用户自定义工具（via FlowConnector 协议） | User |

**扩展机制**:
- FlowConnector 协议（工具接入标准）
- IKnowledgeProvider 接口（知识库接入）
- MCP 支持（远程工具调用）

---

### Layer 5: API & SDK (消费层)

**职责**: 为应用提供统一的执行接口

**形态**:

| 形态 | 场景 | 接口 |
|-----|------|------|
| SDK (进程内) | 高性能、低延迟 | `async function* execute(intent)` |
| HTTP (网络) | 跨进程、分布式 | `POST /api/workflows` + `SSE /stream` |

**能力**:
- 统一的 StreamState 事件流
- 双形态等价（语义相同，形态不同）
- 配置管理（内联 vs 数据库）
- 任务追踪（历史、重放、导出）

---

## 功能清单：What Let-it-Flow Does & Doesn't

### ✅ Let-it-Flow 负责

**编排与执行**:
- Intent → DAG 规划与校验
- 确定性 DAG 执行
- 流式进度反馈 + HITL 门禁
- 多源工具协调

**工具标准化**:
- 工具接入协议 (FlowConnector)
- 知识库接入接口 (IKnowledgeProvider)
- 工具库维护 (web_search / web_fetch 等)

**平台能力**:
- 任务管理与追踪
- 错误处理与恢复
- 配置管理与绑定
- 可观测性 (日志/指标)

---

### ❌ Let-it-flow 不负责

**UI/UX 呈现**:
- 前端流式展示组件 → @meso.ai/ui (上游)
- 应用特定的 UI 定制 → 消费应用 (ai-content-factory / nexusops)
- 平台级通用 UI 模式 → @meso.ai/ui (上游库负责)

**业务逻辑**:
- 播客生成（脚本、TTS） → ai-content-factory
- Discovery Ops（推荐、证据） → nexusops
- 行业分析（报告格式） → 自定义应用

**基础库**:
- 类型定义 → @meso.ai/types
- LLM 客户端 → @meso.ai/client
- 流式 UI 组件 → @meso.ai/ui

---

## 应用生态：Reference Implementations

### 1. ai-content-factory (播客生成)

**定位**: 参考实现 + 完整 demo

**职责**:
- 展示如何使用 let-it-flow SDK/HTTP
- 实现播客生成的业务流程（web_search → script → TTS）
- 提供前端界面（基于 @meso.ai/ui）
- 演示 HITL 工作流（多线索反问、人工审核）

**代码范围**:
- `apps/ai-content-factory/server/` — 应用业务逻辑
- `apps/ai-content-factory/web/` — 前端 UI
- 使用 let-it-flow SDK 作为后端编排引擎

**独立性**: 
- ✅ 独立运行（standalone app）
- ✅ 自有数据库 + 业务逻辑
- ✅ 自有前端 + 样式
- ❌ 不应该被其他应用复用（业务特定）

---

### 2. nexusops (Discovery Ops)

**定位**: 参考实现 + 完整 demo

**职责**:
- 展示 ReAct + 推荐引擎集成
- 实现发现类应用（web → 推荐 → 证据链）
- 提供前端界面（基于 @meso.ai/ui）
- 演示 ETCLOVG 评估框架

**代码范围**:
- `apps/nexusops/server/` — 应用业务逻辑
- `apps/nexusops/web/` — 前端 UI
- 使用 let-it-flow SDK 作为后端编排引擎

**独立性**:
- ✅ 独立运行（standalone app）
- ✅ 自有推荐模型 + 证据链逻辑
- ✅ 自有前端 + 样式
- ❌ 不应该被其他应用复用（应用特定）

---

### 3. examples/podcast-generator (静态 DAG 示例)

**定位**: 教学示例

**职责**:
- 展示如何构建静态 DAG（不通过 LLM 规划）
- 演示工具集成（web_search + knowledge_base + llm）
- 作为新手入门的参考

**代码范围**:
- `examples/podcast-generator/` — 独立示例
- 可直接运行，不依赖平台级应用

---

## 包管理与依赖关系

### 项目结构

```
let-it-flow/
├── src/                          # 平台核心
│   ├── planner/                  # LLM 规划器
│   ├── executor/                 # DAG 执行器
│   ├── tools/                    # 工具生态
│   ├── api/                      # HTTP API
│   └── sdk/                      # SDK 接口
│
├── packages/common-ui/           # 平台级 UI 组件
│   └── (→ @meso.ai/ui re-export)  # 计划迁移到上游
│
├── apps/                         # 消费级应用
│   ├── ai-content-factory/       # 播客 demo
│   └── nexusops/                 # Discovery demo
│
└── docs/                         # 设计文档
    ├── 01-overview.md
    ├── 02-architecture.md
    └── ...
```

### 依赖方向

```
消费应用               平台核心              上游库
(应用特定)           (通用编排)           (基础设施)

ai-content-factory
    ↓                  ↓
  uses            let-it-flow         uses  @meso.ai/types
    ↓                  ↓                       @meso.ai/ui
                    uses              ←     @meso.ai/client
                       ↓
nexusops  ────────→    sdk
    ↓              executor
                   planner
                   tools
```

### 包发布策略

| 包 | 来源 | 发布到 npm | 说明 |
|----|------|-----------|------|
| let-it-flow | Platform | ✅ | 编排框架 + 工具 |
| @let-it-flow/common-ui | Platform | ⏳ 计划迁移 | UI 组件 (→@meso.ai/ui) |
| ai-content-factory | Apps | ❌ | 应用特定，不发布 |
| nexusops | Apps | ❌ | 应用特定，不发布 |

---

## 版本同步策略

### 依赖版本

| 依赖 | 版本 | 更新策略 |
|-----|------|---------|
| @meso.ai/types | ~2.1.0 | 跟踪上游，minor版本 breaking |
| @meso.ai/ui | ~3.1.0 | 跟踪上游，minor版本 breaking |
| @meso.ai/client | ^0.1.0 | 跟踪上游，0.x 期间任意版本 |

### 消费应用

- 依赖 let-it-flow 的特定版本（lock via package.json）
- 独立管理自己的依赖版本
- 可与其他消费应用使用不同的 let-it-flow 版本

---

## Platform Responsibilities Matrix

| 维度 | 平台 (let-it-flow) | 消费应用 | 上游库 (@meso.ai) |
|-----|------------------|--------|-----------------|
| **编排** | ✅ DAG 规划/执行 | ❌ | - |
| **工具** | ✅ 标准工具库 | ✅ 自定义工具 | - |
| **业务逻辑** | ❌ | ✅ 应用特定 | ❌ |
| **UI 展示** | ❌ | ✅ 应用定制 | ✅ 通用组件 |
| **知识库** | ✅ 接入协议 | ✅ 业务数据 | - |
| **LLM 集成** | ✅ 配置/路由 | ❌ | ✅ 客户端库 |
| **流式推送** | ✅ 技术实现 | ❌ | ✅ 前端组件 |

---

## Growth Roadmap

### Phase 1: Core Platform (✅ Current)
- [x] Intent → DAG 规划
- [x] DAG 确定性执行
- [x] 工具生态框架
- [x] SDK + HTTP API
- [x] 参考实现 (ai-content-factory + nexusops)

### Phase 2: Ecosystem Maturity
- [ ] 工具市场（第三方工具发现、评分）
- [ ] 模板市场（社区贡献的工作流模板）
- [ ] 参考应用扩展（更多行业 demo）
- [ ] 平台级通用组件稳定（@meso.ai/ui 完全替代 common-ui）

### Phase 3: Enterprise Readiness
- [ ] 多租户支持
- [ ] 高级权限管理
- [ ] 审计日志 + 合规
- [ ] 部署选项 (Self-hosted / SaaS)

### Phase 4: Community & Ecosystem
- [ ] 开源贡献指南
- [ ] 插件生态
- [ ] 认证培训计划
- [ ] 合作伙伴计划

---

## FAQs

### Q: let-it-flow 与 @meso.ai/ui 的关系是什么？

**A**: 
- let-it-flow = **后端编排平台**（Intent → DAG → 执行）
- @meso.ai/ui = **前端展示库**（流式 UI 组件）
- 关系: let-it-flow 是 @meso.ai/ui 的消费者（使用通用组件）
- 当前: packages/common-ui 作为过渡层，计划迁移到 @meso.ai/ui

### Q: ai-content-factory / nexusops 是 SaaS 产品还是开源参考？

**A**: 都是。
- **开源参考**: 代码完全公开，展示最佳实践
- **可部署**: 可单独部署为独立应用
- **不是 SaaS**: let-it-flow 官方不运营这些应用的云服务
- 用户可以 fork 或基于这些代码开发自己的应用

### Q: 平台的边界在哪里？

**A**: 
- ✅ **平台内**: 编排（规划/执行）、工具协议、工作流管理
- ❌ **平台外**: 业务逻辑、UI 定制、数据存储架构

### Q: 如何为 let-it-flow 贡献新工具？

**A**: 
1. 实现 FlowConnector 协议
2. 提交 PR 到 src/tools/
3. 包含单元测试 + 文档
4. 社区评审通过后合并

### Q: 平台支持什么 LLM？

**A**: 任何 @meso.ai/client 支持的 LLM（OpenAI / Azure / Anthropic / etc.）
- 在配置时指定 model 和 provider
- 平台不偏好特定 LLM，但推荐高性能模型（GPT-4o 等）用于规划

---

## References

- [docs/01-overview.md](./01-overview.md) — 项目总览
- [docs/02-architecture.md](./02-architecture.md) — 架构详解
- [docs/03-dag-schema.md](./03-dag-schema.md) — DAG 规范
- [docs/04-tool-protocol.md](./04-tool-protocol.md) — 工具协议
- [apps/ai-content-factory/README.md](../apps/ai-content-factory/README.md) — 应用参考
- [apps/nexusops/README.md](../apps/nexusops/README.md) — 应用参考
