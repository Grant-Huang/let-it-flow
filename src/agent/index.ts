/**
 * ReAct Harness 入口（ETCLOVG E+L+O 层 + V/G 框架）。
 *
 * 这是平台内核一等公民：所有消费应用通过 runReactHarness 复用 ReAct 范式。
 * 应用只需提供工具集（T 内容）+ 知识库（C 内容）+ precondition（V 规则）+ governance（G 规则）。
 */
export { runReactHarness } from "./react-harness.js";
export { buildStopWhen, DEFAULT_MAX_STEPS, DEFAULT_FINALIZE_TOOL } from "./stop-policy.js";
export { adaptTool, adaptToolSet, toolNameToKey, keyToToolName } from "./tool-adapter.js";
export type { ToolAdapterDeps } from "./tool-adapter.js";
export { TraceAccumulator, emitStepPhase } from "./step-emitter.js";
export { createSkill } from "./skill-bridge.js";
export type { SkillConnector, SkillStep } from "./skill-bridge.js";
export { PreconditionRegistry, calledToolNames } from "./precondition.js";
export { GovernanceChain } from "./governance.js";
export type { GovernanceRule } from "./governance.js";
export type {
  HarnessConfig,
  HarnessResult,
  StepTrace,
  StopPolicyConfig,
  Precondition,
  GovernanceHooks,
  PrepareStepContext,
  PrepareStepResult,
  HitlGateFn,
  EmitFn,
} from "./types.js";
