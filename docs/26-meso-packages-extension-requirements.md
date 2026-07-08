# 26 - 给 meso 团队的包修改要求（@meso.ai/types 2.2.0 / @meso.ai/ui 3.3.0）

> 本文档是 let-it-flow 项目对 `@meso.ai/types` 和 `@meso.ai/ui` 两个外部包的修改要求，供 meso 团队实施。
>
> 配套文档：[25-platform-streaming-improvement-proposal.md](25-platform-streaming-improvement-proposal.md) 平台回归清单 R3。

## 26.1 背景与目标

### 26.1.1 现状

`@meso.ai/types@2.1.1` 定义了 SSE 协议，其中 `extension` 事件是个"万能袋"：

```typescript
// protocol.d.ts:397-405
export interface ExtensionPayload {
  name: string;          // 任意字符串，应用自定义
  version?: string;
  data: unknown;         // 任意结构
}
export type ExtensionEvent = Envelope<'extension', ExtensionPayload>;
```

`applyEvent`（types 包内）对 extension 事件只做最低限度处理（`index.js:298-309`）：

```javascript
case "extension": {
  const { name: e } = o.payload;
  a = {
    ...r,
    extensions: {
      ...r.extensions,
      [e]: [...r.extensions[e] ?? [], o]      // 按 name 分组
    },
    extensionLog: [...r.extensionLog, o]      // 时序日志
  };
  break;
}
```

**问题**：每个 ReAct 应用（如 NexusOps）都在 extension 里承载相似的会话生命周期信号（产物清单、证据不足、收尾摘要、轨迹持久化），但 `name` 和 `data` schema 各自定义，前端要为每个应用重写渲染逻辑，无法跨应用复用。

### 26.1.2 目标

在 `@meso.ai/types` 定义**预设子类型**（preset extensions），让：

1. 后端 emit 预设 name 时，`applyEvent` 做**语义归约**（如 artifacts 转换为 artifact 事件流、react_result 累加 usage）
2. 前端组件（`@meso.ai/ui`）能直接消费归约后的状态，跨应用开箱即用
3. 应用自定义的 extension name 仍透传到 `extensions[name][]` 和 `extensionLog`，保持扩展性

### 26.1.3 设计纪律

- **向后兼容**：schema_version 仍是 `"1.0"`，只是 `applyEvent` 多了语义归约分支
- **向后兼容旧 name**：当前 NexusOps emit 的 `nexus_artifacts` / `react_step_trace` 通过别名映射归约到对应预设
- **不强制**：应用可继续用自定义 name，预设只是"推荐契约"

---

## 26.2 预设子类型清单

共 **5 个预设子类型**，去掉应用前缀（`nexus_`），跨应用通用：

| 预设 name | 用途 | 来源（当前形态） | 前端是否渲染 |
|-----------|------|-----------------|-------------|
| `confirm_gate` | HITL 确认门（write/destructive 工具执行前） | 平台 [registry.ts:208](../src/tasks/registry.ts) 已有 | 是（ConfirmGate 组件） |
| `precondition_unmet` | 证据不足收尾（V 层前置条件未满足） | NexusOps [boot.ts:636-647](../apps/nexusops/server/boot.ts) | 是（Banner） |
| `artifacts` | 产物清单（core.deliver 产出的制品） | NexusOps `nexus_artifacts` [boot.ts:684-688](../apps/nexusops/server/boot.ts) | 是（ArtifactPanel） |
| `react_result` | ReAct 收尾摘要（finishReason + 步数 + usage） | NexusOps [boot.ts:691-702](../apps/nexusops/server/boot.ts) | 否（数据载体） |
| `step_trace` | 完整轨迹（供多轮追问还原上下文） | NexusOps `react_step_trace` [boot.ts:705-712](../apps/nexusops/server/boot.ts) | 否（仅持久化） |

### 26.2.1 旧 name 别名映射

`applyEvent` 内部做别名归约：

| 旧 name（向后兼容） | 归约到（预设 name） |
|-------------------|-------------------|
| `nexus_artifacts` | `artifacts` |
| `react_step_trace` | `step_trace` |

别名映射后，前端状态里**只保留预设 name**（避免双份），但 `extensionLog` 保留原始事件（含旧 name，供审计）。

---

## 26.3 `@meso.ai/types` 修改要求（目标版本 2.2.0）

### 26.3.1 新增类型定义

在 `protocol.d.ts` 新增预设子类型的 data 接口：

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Preset extension payloads (v2.2.0)
// These are RECOMMENDED contracts — backends emit them with the preset name,
// and applyEvent performs semantic reduction. Custom names remain transparent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HITL confirmation gate — emitted before write/destructive tool execution.
 * Pauses stream until POST /api/tasks/:id/confirm arrives.
 */
export interface ConfirmGateData {
  /** Unique gate id; correlates with the subsequent confirm API call. */
  gate_id: string;
  /** Logical node id (e.g. tool name, DAG node). */
  node_id: string;
  /** Run/task id. */
  run_id: string;
  /** User-facing prompt explaining what needs approval. */
  prompt: string;
  /** Available decisions; defaults to ["approve", "reject"]. */
  options: string[];
  /** Optional structured context (tool args, risk level, etc.). */
  detail?: Record<string, unknown>;
}

/**
 * Precondition unmet — emitted when finalize is blocked by evidence gaps.
 * Indicates the stream will terminate with status "failed" (not "done").
 */
export interface PreconditionUnmetData {
  /** Machine-readable reason: "precondition_unmet" (reserved for future codes). */
  finishReason: string;
  /** LLM-generated user-facing summary of what's missing. */
  finalText?: string;
  /** Token usage so far (for billing/analytics). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /**
   * Optional list of missing evidence domains (e.g. ["OEE", "downtime"]).
   * Backends may omit this if domain knowledge isn't structured.
   */
  missingDomains?: string[];
}

/**
 * Artifacts produced during the session (e.g. reports, diagrams, code).
 * Distinct from the `artifact` EVENT stream: artifacts extension carries
 * a SUMMARY list (title + description), while the artifact event carries
 * incremental CONTENT deltas. applyEvent bridges them (see 26.3.3).
 */
export interface ArtifactItem {
  /** Content type/lang: "html preview" | "mermaid" | "python" | "report_html" | ... */
  type: string;
  /** Human-readable title. */
  title: string;
  /** Short description (≤ 120 chars); optional. */
  description?: string;
}

export interface ArtifactsData {
  items: ArtifactItem[];
}

/**
 * ReAct session summary — emitted on finalize.
 * Carries finish reason, step count, and aggregate usage. Non-rendering;
 * consumed by analytics/state for usage accumulation.
 */
export interface ReactResultData {
  /** "finalize_tool" | "precondition_unmet" | "step_count" | "no_tool_call" | "error" | ... */
  finishReason: string;
  /** Number of ReAct steps executed. */
  stepCount: number;
  /** Aggregate token usage. */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Full step trace for multi-turn follow-up.
 * Persisted but NOT rendered; consumed by backend's previous-context loader
 * to reconstruct compressed history for the next turn.
 */
export interface StepTraceData {
  /** Step trace array (backend-specific shape; frontend treats as opaque). */
  stepTrace: unknown[];
  /** Final LLM text from this turn. */
  finalText: string;
}
```

### 26.3.2 新增预设注册表与 helper

在 `protocol.d.ts` 新增：

```typescript
/**
 * Registry of preset extension names. Backends emitting these names get
 * semantic reduction by applyEvent; custom names remain transparent.
 *
 * Keys are the preset names; values declare schema version (semver for
 * the EXTENSION's data shape, independent of PROTOCOL_VERSION).
 */
export const EXTENSION_PRESETS: Readonly<Record<string, {
  version: string;
  /** Aliases that should be reduced to this preset (backward compat). */
  aliases?: string[];
}>>;

export type PresetExtensionName = keyof typeof EXTENSION_PRESETS;

/** Type guard: is this name a preset (or an alias of one)? */
export function isPresetExtension(name: string): name is PresetExtensionName;

/** Resolve an alias to its canonical preset name. Returns the input if not an alias. */
export function resolveExtensionAlias(name: string): string;
```

**期望实现值**（`index.js` 里硬编码）：

```javascript
const EXTENSION_PRESETS = {
  confirm_gate:       { version: "1.0" },
  precondition_unmet: { version: "1.0" },
  artifacts:          { version: "1.0", aliases: ["nexus_artifacts"] },
  react_result:       { version: "1.0" },
  step_trace:         { version: "1.0", aliases: ["react_step_trace"] },
};
```

### 26.3.3 `applyEvent` 语义归约要求

当前 `applyEvent` 的 extension 分支（`index.js:298-309`）只做分组。**要求 2.2.0 增强**为：

```javascript
case "extension": {
  const rawName = o.payload.name;
  const canonicalName = resolveExtensionAlias(rawName);  // nexus_artifacts → artifacts

  // 1. 始终填充 extensions + extensionLog（保持当前行为，用 canonicalName 分组）
  let next = {
    ...r,
    extensions: {
      ...r.extensions,
      [canonicalName]: [...(r.extensions[canonicalName] ?? []), { ...o, payload: { ...o.payload, name: canonicalName } }]
    },
    extensionLog: [...r.extensionLog, o]   // 保留原始 name
  };

  // 2. 预设子类型的语义归约
  switch (canonicalName) {
    case "confirm_gate": {
      // 保持现有 tool_status 联动（tool_call.requires_confirm 已处理）
      // 新增：把 gate 挂到 state.activeConfirmGate（便于 UI 全局查询）
      const data = o.payload.data;
      if (data && typeof data === "object" && "gate_id" in data) {
        next.activeConfirmGate = data;   // ConfirmGateData
      }
      break;
    }
    case "precondition_unmet": {
      // 新增：标记会话因证据不足终止
      const data = o.payload.data ?? {};
      next.preconditionGaps = Array.isArray(data.missingDomains) ? data.missingDomains : [];
      next.preconditionSummary = typeof data.finalText === "string" ? data.finalText : null;
      break;
    }
    case "artifacts": {
      // 新增：把 items 合并进 state.artifacts（复用 artifact 事件的 ArtifactState 结构）
      // 每个 item 生成一个稳定 id（name + index），done=true，content=description 或 ""
      const items = (o.payload.data?.items) ?? [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const artId = `ext-${canonicalName}-${i}-${encodeURIComponent(item.title ?? "")}`;
        if (!next.artifactOrder.includes(artId)) {
          next.artifactOrder = [...next.artifactOrder, artId];
        }
        next.artifacts = {
          ...next.artifacts,
          [artId]: {
            id: artId,
            lang: item.type ?? "unknown",
            content: item.description ?? "",
            done: true,
          },
        };
      }
      break;
    }
    case "react_result": {
      // 新增：累加 usage 到 state.totalUsage（跨步骤汇总）
      const usage = o.payload.data?.usage ?? {};
      const prev = next.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      next.totalUsage = {
        inputTokens:  (prev.inputTokens  ?? 0) + (usage.inputTokens  ?? 0),
        outputTokens: (prev.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        totalTokens:  (prev.totalTokens  ?? 0) + (usage.totalTokens  ?? 0),
      };
      next.lastFinishReason = o.payload.data?.finishReason ?? null;
      break;
    }
    case "step_trace": {
      // 不做额外归约（仅持久化在 extensions + extensionLog）
      // 但保证 canonicalName = "step_trace"（便于多轮追问读取）
      break;
    }
    // default: 自定义 name，不做额外归约（已由第 1 步透传）
  }

  a = next;
  break;
}
```

### 26.3.4 `StreamState` 新增字段

在 `streamState.d.ts` 的 `StreamState` interface 新增（全部可选，向后兼容）：

```typescript
export interface StreamState {
  // ... 现有字段 ...

  /** Active confirmation gate (from confirm_gate extension). null until received. */
  activeConfirmGate?: import('./protocol').ConfirmGateData | null;

  /** Missing evidence domains (from precondition_unmet extension). Empty if not applicable. */
  preconditionGaps?: string[];

  /** User-facing summary when precondition_unmet fires. null if not applicable. */
  preconditionSummary?: string | null;

  /** Aggregate token usage across all react_result extensions. */
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Last finish reason (from the most recent react_result extension). */
  lastFinishReason?: string | null;
}
```

`createInitialStreamState()` 相应补默认值：

```javascript
function createInitialStreamState() {
  return {
    // ... 现有字段 ...
    activeConfirmGate: null,
    preconditionGaps: [],
    preconditionSummary: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lastFinishReason: null,
  };
}
```

### 26.3.5 导出清单更新

`index.d.ts` 新增导出：

```typescript
export { EXTENSION_PRESETS, isPresetExtension, resolveExtensionAlias } from './protocol';
export type {
  ConfirmGateData,
  PreconditionUnmetData,
  ArtifactItem,
  ArtifactsData,
  ReactResultData,
  StepTraceData,
  PresetExtensionName,
} from './protocol';
```

---

## 26.4 `@meso.ai/ui` 修改要求（目标版本 3.3.0）

### 26.4.1 依赖升级

`package.json` peerDependencies：

```json
{
  "peerDependencies": {
    "@meso.ai/types": ">=2.2.0"
  }
}
```

### 26.4.2 re-export 新增类型

`index.d.ts` 新增 re-export（从 `@meso.ai/types`）：

```typescript
export {
  EXTENSION_PRESETS,
  isPresetExtension,
  resolveExtensionAlias,
} from './runtime';

export type {
  ConfirmGateData,
  PreconditionUnmetData,
  ArtifactItem,
  ArtifactsData,
  ReactResultData,
  StepTraceData,
  PresetExtensionName,
} from './runtime';
```

`runtime/index.d.ts` 相应 re-export（已有从 `@meso.ai/types` re-export 的模式，照抄即可）。

### 26.4.3 `ArtifactPanel` 增强

当前 `ArtifactPanel` 从 `state.artifacts` + `state.artifactOrder` 渲染（基于 `artifact` 事件流）。**无需改动**——因为 `@meso.ai/types@2.2.0` 的 `applyEvent` 会把 `artifacts` extension 转换为 `ArtifactState` 条目（见 26.3.3），`ArtifactPanel` 透明地同时展示两类来源。

**验收**：传入一个含 `artifacts` extension 的 StreamState，`ArtifactPanel` 能渲染出 items。

### 26.4.4 新增可选组件 `<PreconditionUnmetBanner>`

```typescript
export interface PreconditionUnmetBannerProps {
  /** StreamState.preconditionGaps — missing evidence domains. */
  gaps?: string[];
  /** StreamState.preconditionSummary — user-facing summary text. */
  summary?: string | null;
  /** Optional callback when user wants to retry / supplement. */
  onRetry?: () => void;
}

export function PreconditionUnmetBanner(props: PreconditionUnmetBannerProps): JSX.Element | null;
```

**渲染规格**：
- 当 `gaps` 为空数组且 `summary` 为 null/空 → 返回 null（不渲染）
- 否则渲染一个黄色边框的 banner：
  - 标题：⚠ 证据不足，前置条件未满足
  - 正文：`summary`（若有），否则提示"分析所需的取证数据未齐备"
  - gaps 以 tag 形式列出（如 `OEE`、`downtime`）
  - 若有 `onRetry`，显示"补充信息后重试"按钮

**用途**：应用可选启用。NexusOps 当前用自写的 `renderExtension.tsx` 处理 `precondition_unmet`，可逐步迁移到此组件。

### 26.4.5 `renderExtension` prop 机制保持

**重要**：`MessageList` 的 `renderExtension` prop 机制**完全保留**。应用仍可自定义 extension 渲染。预设组件是**可选便利**，不是强制。

---

## 26.5 兼容性矩阵

| 场景 | 后端 emit | applyEvent 行为（2.2.0） | 前端 |
|------|----------|-------------------------|------|
| 预设 name（新） | `extension(name="artifacts")` | 归约到 `state.artifacts` + `extensions["artifacts"]` | ArtifactPanel 自动展示 |
| 旧 name（别名） | `extension(name="nexus_artifacts")` | 别名映射 → 归约到 `state.artifacts` + `extensions["artifacts"]` | 同上（透明） |
| 自定义 name | `extension(name="my_app_custom")` | 透传到 `extensions["my_app_custom"]` + `extensionLog` | 应用自写 renderExtension |
| 混合（双发） | 同时 emit `artifacts` + `nexus_artifacts` | `extensions["artifacts"]` 会有两条（去重在 26.6 讨论） | 建议后端只发一个 |

### 26.5.1 双发去重建议

let-it-flow 平台在迁移期可能"双发"（新 name + 旧 name 镜像）。**建议 meso 团队实现幂等性**：

- `artifacts` 归约时，若 item 的 `title` 已存在（基于 `ext-artifacts-N-{title}` id），跳过不重复插入
- `react_result` 累加 usage 时，若同一 `finishReason` + 相同 `stepCount` 已处理过，跳过（避免双倍计数）

**或者**（更简单）：let-it-flow 平台侧保证只发一份，依赖 meso 的别名映射处理旧前端。**推荐此方案**，meso 包无需做去重。

---

## 26.6 测试要求

meso 团队需在 `runtime/__tests__/runtime.contract.test.ts`（或等效测试文件）补充以下用例：

### 26.6.1 预设归约测试

```typescript
describe('preset extension reduction', () => {
  it('confirm_gate populates activeConfirmGate', () => {
    const state = applyEvent(createInitialStreamState(), {
      type: "extension", schema_version: "1.0",
      payload: { name: "confirm_gate", version: "1.0", data: { gate_id: "g_123", node_id: "tool_x", run_id: "r1", prompt: "Approve?", options: ["approve", "reject"] } }
    });
    expect(state.activeConfirmGate).toEqual({ gate_id: "g_123", ... });
    expect(state.extensions["confirm_gate"]).toHaveLength(1);
  });

  it('precondition_unmet populates gaps and summary', () => {
    const state = applyEvent(initial, { ... name: "precondition_unmet", data: { finishReason: "precondition_unmet", finalText: "缺 OEE 数据", missingDomains: ["OEE"] } });
    expect(state.preconditionGaps).toEqual(["OEE"]);
    expect(state.preconditionSummary).toBe("缺 OEE 数据");
  });

  it('artifacts merges into state.artifacts', () => {
    const state = applyEvent(initial, { ... name: "artifacts", data: { items: [{ type: "report_html", title: "OEE 报告", description: "7月数据" }] } });
    expect(state.artifactOrder).toHaveLength(1);
    expect(Object.values(state.artifacts)[0].lang).toBe("report_html");
  });

  it('react_result accumulates usage', () => {
    let state = applyEvent(initial, { ... name: "react_result", data: { finishReason: "finalize_tool", stepCount: 5, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } } });
    state = applyEvent(state, { ... name: "react_result", data: { finishReason: "finalize_tool", stepCount: 3, usage: { inputTokens: 200, totalTokens: 300 } } });
    expect(state.totalUsage.totalTokens).toBe(450);
    expect(state.lastFinishReason).toBe("finalize_tool");
  });

  it('step_trace reduces to canonical name only', () => {
    const state = applyEvent(initial, { ... name: "step_trace", data: { stepTrace: [], finalText: "" } });
    expect(state.extensions["step_trace"]).toHaveLength(1);
    expect(state.extensions["react_step_trace"]).toBeUndefined();
  });
});
```

### 26.6.2 别名映射测试

```typescript
describe('alias mapping', () => {
  it('nexus_artifacts → artifacts', () => {
    const state = applyEvent(initial, { ... name: "nexus_artifacts", data: { items: [...] } });
    expect(state.extensions["artifacts"]).toHaveLength(1);
    expect(state.extensions["nexus_artifacts"]).toBeUndefined();
    expect(state.extensionLog[0].payload.name).toBe("nexus_artifacts");  // 原始 name 保留在 log
  });

  it('react_step_trace → step_trace', () => {
    const state = applyEvent(initial, { ... name: "react_step_trace", data: { stepTrace: [], finalText: "" } });
    expect(state.extensions["step_trace"]).toHaveLength(1);
  });

  it('isPresetExtension recognizes aliases', () => {
    expect(isPresetExtension("nexus_artifacts")).toBe(true);
    expect(isPresetExtension("artifacts")).toBe(true);
    expect(isPresetExtension("custom_xxx")).toBe(false);
  });

  it('resolveExtensionAlias returns canonical', () => {
    expect(resolveExtensionAlias("nexus_artifacts")).toBe("artifacts");
    expect(resolveExtensionAlias("artifacts")).toBe("artifacts");
    expect(resolveExtensionAlias("custom")).toBe("custom");
  });
});
```

### 26.6.3 未知 name 透传测试（回归保障）

```typescript
describe('custom name transparency', () => {
  it('custom name passes through unchanged', () => {
    const state = applyEvent(initial, { ... name: "my_app_widget", data: { foo: "bar" } });
    expect(state.extensions["my_app_widget"]).toHaveLength(1);
    expect(state.extensions["my_app_widget"][0].payload.data).toEqual({ foo: "bar" });
    // 不触发任何语义归约
    expect(state.totalUsage.totalTokens).toBe(0);
    expect(state.artifactOrder).toHaveLength(0);
  });
});
```

### 26.6.4 向后兼容测试

```typescript
describe('backward compat with 2.1.1', () => {
  it('schema_version stays "1.0"', () => {
    // 协议版本号不变
    expect(PROTOCOL_VERSION).toBe("1.1"); // 或保持 "1.0"，见 26.7.1
  });

  it('StreamState without new fields still works', () => {
    // 老的 StreamState（无 totalUsage 等新字段）传入 applyEvent 不报错
    const legacyState = { ...createInitialStreamState() };
    delete legacyState.totalUsage;
    const state = applyEvent(legacyState, { type: "text", schema_version: "1.0", payload: { delta: "hi" } });
    expect(state.textContent).toBe("hi");
  });
});
```

---

## 26.7 版本与发布

### 26.7.1 版本号

| 包 | 当前版本 | 目标版本 | 说明 |
|----|---------|---------|------|
| `@meso.ai/types` | 2.1.1 | **2.2.0** | minor 版本（新增功能，向后兼容） |
| `@meso.ai/ui` | 3.2.0 | **3.3.0** | minor 版本（新增组件 + re-export） |

**PROTOCOL_VERSION 决策**：建议保持 `"1.0"`（事件信封结构未变，只是 applyEvent 多了归约分支）。若 meso 团队认为 applyEvent 的语义变化值得反映到协议版本，可升级到 `"1.1"`，但必须保证 `isCompatibleVersion("1.0")` 仍返回 true（向后兼容）。

### 26.7.2 发布清单

发布前确认：
- [ ] `@meso.ai/types@2.2.0` 构建产物含 `EXTENSION_PRESETS` / `isPresetExtension` / `resolveExtensionAlias`
- [ ] `applyEvent` 对 5 个预设 name + 2 个别名做语义归约
- [ ] `StreamState` 新字段（`activeConfirmGate` 等）在 `createInitialStreamState()` 有默认值
- [ ] 所有测试用例（26.6）通过
- [ ] `@meso.ai/ui@3.3.0` 构建产物含 re-export + `<PreconditionUnmetBanner>`
- [ ] peerDependencies 声明 `@meso.ai/types@>=2.2.0`

### 26.7.3 发布后通知

发布后请通知 let-it-flow 团队（通过 issue / PR），附：
- types 2.2.0 的 npm tarball 链接
- ui 3.3.0 的 npm tarball 链接
- 测试报告（26.6 全部用例通过截图）

let-it-flow 团队收到后将执行 [M1b 阶段](25-platform-streaming-improvement-proposal.md)：升级依赖 + 迁移 NexusOps 到新 name。

---

## 26.8 实施优先级

| 优先级 | 工作项 | 工作量 |
|--------|-------|--------|
| **P0** | EXTENSION_PRESETS 注册表 + isPresetExtension + resolveExtensionAlias | 0.5 天 |
| **P0** | applyEvent 别名映射（nexus_artifacts → artifacts 等） | 0.5 天 |
| **P0** | 5 个预设的 applyEvent 语义归约 | 1 天 |
| **P0** | StreamState 新字段 + createInitialStreamState 默认值 | 0.5 天 |
| **P0** | 测试用例（26.6 全部） | 1 天 |
| **P1** | `@meso.ai/ui` re-export + PreconditionUnmetBanner 组件 | 1 天 |
| **P1** | 发布 types 2.2.0 + ui 3.3.0 | 0.5 天 |

**总计**：约 5 个工作日。

---

## 26.9 开放问题（需 meso 团队确认）

1. **`schema_version` 是否升级到 "1.1"？**（见 26.7.1）—— let-it-flow 倾向保持 "1.0"。
2. **`step_trace` 的 `stepTrace` 字段是否需要强类型？**—— let-it-flow 当前用平台层 `StepTrace[]`，但跨包耦合成本高，建议保持 `unknown[]`，类型由后端保证。
3. **`artifacts` 归约生成 artifact id 的稳定性**——当前提议 `ext-artifacts-{index}-{title}`，若 items 顺序变化会导致 id 变化。是否需要后端提供稳定 id？

---

## 26.10 联系方式

- let-it-flow 仓库：本仓库
- 文档作者：let-it-flow 团队
- 配套文档：[25-platform-streaming-improvement-proposal.md](25-platform-streaming-improvement-proposal.md) R3 章节

如有疑问，请在 let-it-flow 仓库提 issue 并 @ 维护者。
