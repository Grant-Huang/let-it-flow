# Meso.ai 迁移指引

本页记录每个 Breaking Change 版本的字段对照表和迁移步骤。

---

## v1.x → v2.0 / v3.0（Breaking Cleanup）

`@meso.ai/types@2.0.0` 与 `@meso.ai/ui@3.0.0` **不保留运行时兼容**。请一次性升级后端事件、前端状态访问与 UI 集成。

```bash
pnpm add @meso.ai/types@2.0.0 @meso.ai/ui@3.0.0
```

### stage → phase 迁移

| 旧 (`stage`) | 新 (`phase`) |
|--------------|--------------|
| `{ type:"stage", payload:{ name, state:"active" } }` | `{ type:"phase", payload:{ id, name, state:"running" } }` |
| `state:"done"` | `state:"done"` + 可选 `body` / `pinned_think` |
| `StreamState.stages` | `StreamState.phases` + `phaseOrder` |
| `onStageChange` | `onPhaseChange` |
| `showProcessTrace={false}` | 已删除，`MessageList` 统一使用 `ProcessTrace` |
| `stagePayloadToStage` | `phaseRecordToStage`（`PhaseRecord` → `StageTimeline` 视觉原语）|

**Python 后端（最小示例）：**

```python
# 旧
yield sse({"type": "stage", "schema_version": "1.0",
           "payload": {"name": "检索", "state": "active"}})

# 新
yield sse({"type": "phase", "schema_version": "1.0",
           "payload": {"id": "search", "name": "检索", "state": "running"}})
```

**Node 后端（最小示例）：**

```typescript
// 旧
writeSSE({ type: 'stage', schema_version: '1.0',
           payload: { name: '检索', state: 'active' } })

// 新
writeSSE({ type: 'phase', schema_version: '1.0',
           payload: { id: 'search', name: '检索', state: 'running' } })
```

**前端状态访问：**

```tsx
// 旧
{state.stages.map(s => <Chip key={s.name}>{s.name}</Chip>)}

// 新
{state.phaseOrder.map(id => {
  const phase = state.phases[id]
  return <Chip key={id}>{phase.name}</Chip>
})}
```

### tool_progress / confirm_gate → 标准工具事件

| 旧 (`extension`) | 新（标准事件） |
|------------------|----------------|
| `extension("tool_progress", { status:"running" })` | `tool_call` + `tool_status`（`running`）|
| `extension("tool_progress", { status:"done" })` | `tool_result` |
| `extension("confirm_gate", …)` | `tool_call`（`requires_confirm`）+ `ConfirmGate` UI |

工具进度请使用 `tool_call` → `tool_status` → `tool_result` 序列；需用户确认时使用 `tool_call` 的 `requires_confirm` 与 `@meso.ai/ui` 的 `ConfirmGate` / `ToolCallBlock`。

### 已删除的 API

- `StagePayload` / `StageEvent` / `StreamState.stages`
- `MessageList.showProcessTrace`
- `ProcessTrace.renderStageBody`
- `useSSEStream.onStageChange`
- 静态 HTML demo（`docs/demo/`、`docs/industrial-vision.html`）— 请使用 React [`demo/`](../../demo/)

---

## v1.2.1 → v1.2.2（patch，@meso.ai/types）

无 breaking change。修复与增强：

- `tool_result` 保留 `groupId` / `groupKind`
- `tool_call` 对 write/destructive/`requires_confirm` 自动设 `awaiting_confirm`
- 新增 `tool_status` 事件（`running` / `awaiting_confirm`）
- `StreamState.errorCode` 持久化 `error.code`

```bash
pnpm add @meso.ai/types@1.2.2 @meso.ai/ui@2.1.2
```

---

## v2.1.0 → v2.1.1（patch）

仅 bug fix，无 API 变更，直接升级即可：

```bash
npm install @meso.ai/ui@2.1.1 @meso.ai/types@1.2.1
```

---

## v2.0.x → v2.1.0（minor，向后兼容）

新增功能，**现有代码无需改动**。本节列出可选接入的新能力。

### 新增：`phase` 事件 + per-phase think 流（@meso.ai/types）

`StreamState` 新增 `phases: Record<string, PhaseRecord>` 和 `phaseOrder: string[]`。
现有使用 `phase` 的代码完全不受影响；`phases` 默认为空对象。

```typescript
// 新字段（原有字段不变）
interface StreamState {
  // ...原有字段...
  phases:     Record<string, PhaseRecord>   // NEW
  phaseOrder: string[]                      // NEW
}

interface PhaseRecord {
  id:           string
  name:         string
  state:        'pending' | 'running' | 'done' | 'error'
  thinkContent: string
  pinnedThink?: string
  body?:        string
  startedAt?:   number
  endedAt?:     number
}
```

按需接入：

```tsx
// 渲染 phases（可选，不接入则忽略）
{state.phaseOrder.map(id => {
  const phase = state.phases[id]
  return (
    <div key={id}>
      <span>{phase.name}</span>
      {phase.thinkContent && (
        <ThinkBlock
          content={phase.thinkContent}
          streaming={phase.state === 'running'}
          pinnedContent={phase.pinnedThink}
        />
      )}
    </div>
  )
})}
```

### 新增：`think.phase_id` 路由（@meso.ai/types）

`ThinkPayload` 新增可选字段 `phase_id?: string`。
无 `phase_id` 的 `think` 事件行为**与之前完全相同**，路由到 `thinkContent`。

### 新增：`tool_call.groupId` / `groupKind`（@meso.ai/types）

`ToolCallPayload` 新增 `groupId?: string` 和 `groupKind?: string`，同时提升到 `ToolCallState`：

```typescript
interface ToolCallState {
  call:       ToolCallPayload
  result?:    ToolResultPayload
  status:     ToolCallStatus
  groupId?:   string   // NEW
  groupKind?: string   // NEW
}
```

按 groupId 分组渲染（可选）：

```typescript
// 按 groupId 分组，未设置的 call 各自独立
const byGroup = state.toolCallOrder.reduce((acc, id) => {
  const key = state.toolCalls[id].groupId ?? id
  ;(acc[key] ??= []).push(id)
  return acc
}, {} as Record<string, string[]>)
```

### 新增：`StatusIcon` 组件（@meso.ai/ui）

```tsx
import { StatusIcon } from '@meso.ai/ui'
<StatusIcon status="running" size={16} />
```

状态：`running | done | error | pending | warning`。

### 新增：`LogLine` 组件（@meso.ai/ui）

```tsx
import { LogLine } from '@meso.ai/ui'
<LogLine status="done" primary="已检索 3 篇文档" outcome="用时 1.2s" detail="详细内容…" />
```

### 新增：`ThinkBlock.pinnedContent` + `ThinkBlock.turnStreaming`（@meso.ai/ui）

```tsx
// pinnedContent：done 后显示冻结快照，防止内容 flash
<ThinkBlock
  content={liveContent}
  streaming={isStreaming}
  pinnedContent={phase.pinnedThink}   // done 后显示此值
/>

// turnStreaming：轮次结束时重置用户折叠意图
<ThinkBlock
  content={state.thinkContent}
  streaming={!state.thinkDone}
  turnStreaming={state.status === 'streaming'}
/>
```

### 新增：`useFoldState` hook（@meso.ai/ui）

```tsx
import { useFoldState } from '@meso.ai/ui'

const { open, toggle, clearIntent } = useFoldState({
  system: isStreaming,       // 系统默认展开/折叠
  resetOnTurnStart: true,    // 新轮次开始时重置用户意图
})
```

### 新增：`useSSEStream` watchdog 超时（@meso.ai/ui）

```typescript
start({ watchdogMs: 60_000 })   // 60 秒无数据则超时
start({ watchdogMs: null })     // 禁用超时
// 默认 120_000 ms（120 秒）
```

超时时 `state.status = 'error'`，`onError` 收到 `code: 'WATCHDOG_TIMEOUT'`。

### 新增：`ProcessTrace.renderPhase` + `renderToolCall` 插槽（@meso.ai/ui）

```tsx
<ProcessTrace
  stream={state}
  streaming={isStreaming}
  renderPhase={(phase) => {
    if (phase.id === 'search') return <RetrievalDetail phase={phase} />
    return null
  }}
  renderToolCall={(tc) => {
    if (tc.call.name === 'web_search') return <SearchCard tc={tc} />
    return null
  }}
/>
```

### 新增：设计 token（@meso.ai/ui）

`tokens.css` 新增 `--meso-fs-*` 字体尺寸 scale 和 `--meso-space-*` 间距 scale，均为 stable token：

```css
/* 字体 */
--meso-fs-caption: 12px   /* 角标、执行区 */
--meso-fs-body:    14px   /* 正文 */
--meso-fs-title:   15px   /* 卡片标题 */
--meso-fs-section: 18px   /* 页面区块标题 */

/* 间距（4px 基准）*/
--meso-space-1: 4px  --meso-space-2: 8px  --meso-space-3: 12px
--meso-space-4: 16px --meso-space-5: 20px --meso-space-6: 24px
--meso-indent:  16px
```

完整 token 文档见 [设计系统](#tokens)。

---

## v0.x → v2.0.0

这是一次**协议层 + 状态层双重重构**，引入了版本化信封和多 Artifact 支持。

### SSE 事件格式

v0.x 使用扁平 JSON，v1.0 引入版本化信封（`schema_version` + `payload` 包装）：

| v0.x 格式 | v1.0 格式 |
|-----------|-----------|
| `{"type":"stage","label":"召回","status":"active"}` | `{"type":"stage","schema_version":"1.0","payload":{"name":"召回","state":"active"}}` |
| `{"type":"memory","items":["偏好A","偏好B"]}` | `{"type":"memory","schema_version":"1.0","payload":{"snippets":[{"category":"pref","content":"偏好A"},…]}}` |
| `{"type":"think","delta":"…","done":false}` | `{"type":"think","schema_version":"1.0","payload":{"delta":"…","done":false}}` |
| `{"type":"text","delta":"…"}` | `{"type":"text","schema_version":"1.0","payload":{"delta":"…"}}` |
| `{"type":"artifact","artifactType":"code","language":"py","delta":"…","done":false}` | `{"type":"artifact","schema_version":"1.0","payload":{"id":"a1","lang":"py","delta":"…","done":false}}` |
| `{"type":"done"}` | `{"type":"done","schema_version":"1.0","payload":{}}` |
| `{"type":"error","message":"…"}` | `{"type":"error","schema_version":"1.0","payload":{"message":"…","code":"…"}}` |

**stage 字段重命名：**

| v0.x | v1.0 |
|------|------|
| `label` | `payload.name` |
| `status` | `payload.state` |

**memory 结构变化：**

| v0.x | v1.0 |
|------|------|
| `items: string[]` | `payload.snippets: [{category, content}][]` |

**artifact 字段重命名：**

| v0.x | v1.0 |
|------|------|
| `artifactType` | 由 `payload.lang` 推导（`"html preview"` / `"mermaid"` / 其他）|
| `language` | `payload.lang` |
| （无 id）| `payload.id`（必填，支持多 Artifact）|

### StreamState 字段

| v0.x 字段 | v2.0 字段 |
|-----------|-----------|
| `state.text` | `state.textContent` |
| `state.think` | `state.thinkContent` |
| `state.memories` / `memoryItems` | `state.memorySnippets` |
| `state.artifact` (单个) | `state.artifacts` (Record) + `state.artifactOrder` (string[]) |
| `state.stages[n].label` | `state.stages[n].name` |
| `state.stages[n].status` | `state.stages[n].state` |
| （不存在）| `state.extensions` + `state.extensionLog` |
| （不存在）| `state.thinkDone` |

### 迁移步骤

**后端迁移（推荐方式：一次性切换）：**

```python
# v0.x（旧）
yield f"data: {json.dumps({'type':'text','delta':chunk})}\n\n"

# v1.0（新）
yield f"data: {json.dumps({'type':'text','schema_version':'1.0','payload':{'delta':chunk}})}\n\n"
```

**前端迁移（StreamState 字段）：**

```typescript
// v0.x（旧）
<ChatBubble content={state.text} />
<ThinkBlock content={state.think} />
{state.memories.map(m => <Chip>{m}</Chip>)}
<ArtifactPanel content={state.artifact?.content} />
state.stages[n].label
state.stages[n].status

// v2.0（新）
<ChatBubble content={state.textContent} />
<ThinkBlock content={state.thinkContent} streaming={!state.thinkDone} />
{state.memorySnippets.map(s => <Chip>[{s.category}] {s.content}</Chip>)}
{state.artifactOrder.map(id => <ArtifactPanel content={state.artifacts[id].content} />)}
state.stages[n].name
state.stages[n].state
```

### parseSSELine 宽容模式

`parseSSELine` 对缺失 `schema_version` 宽容处理（视为 `"1.0"`），这意味着 v0.x 的后端在**不发 `payload` 包装**的情况下仍能被解析，但 `applyEvent` 会因为找不到 `payload.*` 字段而忽略大部分数据。**建议彻底迁移，不要依赖宽容模式。**

---

## 版本策略

遵循 [SemVer](https://semver.org/)：

| 变更类型 | 版本 bump |
|---------|----------|
| Bug fix，不影响 API / 协议 / CSS token | Patch（x.y.**z**）|
| 新增功能，向后兼容 | Minor（x.**y**.0）|
| Breaking：API 字段、SSE 协议、稳定 CSS 类名、稳定 token | Major（**x**.0.0）|

协议层 Breaking 变更须：
1. 先更新 `docs/streaming-protocol.md`（单一事实来源）
2. 更新契约测试 fixture
3. 发布新版 `@meso.ai/ui` / `@meso.ai/types`

完整变更历史见 [CHANGELOG.md](../../packages/meso-ui/CHANGELOG.md)。
