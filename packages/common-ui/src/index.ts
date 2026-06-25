/**
 * @let-it-flow/common-ui
 *
 * Common UI components and styles for streaming interfaces.
 *
 * Usage:
 * ```tsx
 * import { CollapsibleStepTrace } from '@let-it-flow/common-ui';
 * import '@let-it-flow/common-ui/styles';
 *
 * <details className="streaming-details">
 *   <summary className="streaming-summary">📋 执行细节</summary>
 *   <CollapsibleStepTrace stream={state} />
 * </details>
 * ```
 */

export { CollapsibleStepTrace } from "./CollapsibleStepTrace";
export { STREAMING_SYMBOLS, symbolForStatus } from "./symbols";

export type { StreamState, ToolCallState } from "@meso.ai/types";
