/**
 * Unified symbol library for streaming session UI
 *
 * ASCII-based symbols aligned with Claude Code streaming session design spec:
 * https://docs.meso.ai/streaming-session-design-spec.md
 *
 * Usage:
 * ```tsx
 * import { STREAMING_SYMBOLS } from '@let-it-flow/common-ui';
 * <div>{STREAMING_SYMBOLS.done} Tool completed</div>
 * ```
 */

export const STREAMING_SYMBOLS = {
  /** Complete/success indicator (> ) */
  done: '> ',
  /** In-progress indicator (~ ) */
  inProgress: '~ ',
  /** Error/failure indicator (✗ ) */
  error: '✗ ',
  /** Branch/nested start (├ ) */
  nested: '├ ',
  /** Nested end (└ ) */
  endNested: '└ ',
  /** Success checkmark (alternative) (✓ ) */
  success: '✓ ',
  /** Pending/awaiting (◇ ) */
  pending: '◇ ',
};

/**
 * Get symbol for tool execution status
 * @param status - Tool status: 'done' | 'running' | 'error'
 * @returns Appropriate symbol from STREAMING_SYMBOLS
 */
export function symbolForStatus(status: 'done' | 'running' | 'error'): string {
  switch (status) {
    case 'done':
      return STREAMING_SYMBOLS.done;
    case 'running':
      return STREAMING_SYMBOLS.inProgress;
    case 'error':
      return STREAMING_SYMBOLS.error;
  }
}
