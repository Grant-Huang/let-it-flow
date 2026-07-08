/**
 * Extension 预设子类型（R3 协议层）。
 *
 * 平台层提供 payload 构造 helper，与 src/core/stream-events.ts 的 confirmGatePayload 风格一致。
 *
 * 设计纪律：
 *   - 类型定义、注册表、别名解析、isPresetExtension 全部从 meso 包 2.2.0 re-export（DRY）
 *   - meso 包 applyEvent 据此做语义归约（artifacts → artifact 事件流、react_result → usage 累加等）
 *   - 平台层只补 meso 包未导出的 ConfirmGateData（meso 2.2.0 通过 tool_status 联动处理 confirm_gate，
 *     没把 data 接口导出；平台保留供后端构造 payload 用）
 *   - meso 2.2.0 的 ArtifactItem.id 是必填字段（稳定 id 作 state key），后端必须生成
 *
 * 见 docs/26-meso-packages-extension-requirements.md。
 */
import type { ExtensionPayload } from "@meso.ai/types";

// meso 包 2.2.0 已导出 EXTENSION_PRESETS / isPresetExtension / resolveExtensionAlias / 类型化 data 接口。
// 平台层 re-export，让应用从 @let-it-flow 单一入口取用（与 src/index.ts 风格一致）。
export {
  EXTENSION_PRESETS,
  isPresetExtension,
  resolveExtensionAlias,
} from "@meso.ai/types";
export type {
  PreconditionUnmetData,
  ArtifactItem,
  ArtifactsData,
  ReactResultData,
  StepTraceData,
  PresetExtensionName,
} from "@meso.ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// 平台层补充：meso 2.2.0 未导出的类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HITL 确认门的 data 接口。
 *
 * meso 2.2.0 通过 tool_status(awaiting_confirm) 联动渲染 ConfirmGate 组件，
 * 没有把 confirm_gate 加进 EXTENSION_PRESETS、也没导出 ConfirmGateData。
 * 平台层保留此接口，供后端构造 extension payload（与 stream-events.ts 的 confirmGatePayload 对齐）。
 */
export interface ConfirmGateData {
  gate_id: string;
  node_id: string;
  run_id: string;
  prompt: string;
  options: string[];
  detail?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload helper（与 stream-events.ts confirmGatePayload 风格一致）
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PreconditionUnmetData,
  ArtifactsData,
  ReactResultData,
  StepTraceData,
} from "@meso.ai/types";

export const preconditionUnmetPayload = (data: PreconditionUnmetData): ExtensionPayload => ({
  name: "precondition_unmet",
  version: "1.0",
  data,
});

export const artifactsPayload = (data: ArtifactsData): ExtensionPayload => ({
  name: "artifacts",
  version: "1.0",
  data,
});

export const reactResultPayload = (data: ReactResultData): ExtensionPayload => ({
  name: "react_result",
  version: "1.0",
  data,
});

export const stepTracePayload = (data: StepTraceData): ExtensionPayload => ({
  name: "step_trace",
  version: "1.0",
  data,
});
