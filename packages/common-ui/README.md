# @let-it-flow/common-ui

Common UI components and styles for streaming interfaces in let-it-flow applications.

⚠️ **Status**: This package is **ready for upstream integration** into @meso.ai/ui. See [UPSTREAM_READY.md](./UPSTREAM_READY.md) for migration timeline and details.

## Overview

This package provides platform-level components and styling for streaming execution displays, following the design pattern established by Claude Code: **keep main message flow clean and linear, hide process details by default, provide collapsible details panels for power users**.

> **Note**: These patterns are being contributed to @meso.ai/ui to make them available to all AI applications. Long-term, consumers should depend on @meso.ai/ui directly. See [docs/22-upstream-migration-plan.md](../docs/22-upstream-migration-plan.md) for details.

## Components

### CollapsibleStepTrace

Displays a collapsible list of tool calls from a streaming execution.

```tsx
import { CollapsibleStepTrace } from '@let-it-flow/common-ui';
import '@let-it-flow/common-ui/styles';

export function LiveTrace({ stream, streaming }) {
  return (
    <div>
      {/* Main trace area */}
      <ProcessTrace stream={stream} streaming={streaming} />

      {/* Collapsible details panel */}
      {stream.toolCallOrder.length > 0 && (
        <details className="streaming-details">
          <summary className="streaming-summary">
            📋 执行细节 ({stream.toolCallOrder.length} 步)
          </summary>
          <CollapsibleStepTrace stream={stream} />
        </details>
      )}
    </div>
  );
}
```

## Styles

### CSS Classes

The package includes comprehensive CSS for streaming UI elements:

- `.streaming-details` - Collapsible details container
- `.streaming-summary` - Summary/toggle button
- `.streaming-step-trace` - Tool call chain container
- `.streaming-step-item` - Individual step item
- `.streaming-step-header` - Step header (number + name + status)
- `.streaming-step-args` - Arguments display
- `.streaming-step-result` - Result/error display

### Design Principles

1. **Compact by Default**: Metadata (parameters, execution time) hidden by default
2. **Progressive Disclosure**: Click to expand and see full details
3. **Status Priority**: Tool status (✓/✗/⟳) always visible
4. **Visual Hierarchy**: Color-coded borders based on status (success/error/running)

### CSS Variables Used

- `--color-bg` / `--color-bg-elevated` / `--color-bg-hover` - Background colors
- `--color-text-*` - Text colors (primary, secondary, muted)
- `--color-border*` - Border colors
- `--color-success` / `--color-error` / `--color-info` - Status colors

## Integration

### For ai-content-factory

Replace inline `StepTraceCollapsible` with imported component:

```diff
- import { StepTraceCollapsible } from './renderLiveTrace';
+ import { CollapsibleStepTrace } from '@let-it-flow/common-ui';
+ import '@let-it-flow/common-ui/styles';

- <StepTraceCollapsible stream={stream} />
+ <CollapsibleStepTrace stream={stream} />
```

### For nexusops

Apply same pattern as ai-content-factory.

### For New Consumer Applications

1. Install: `npm install @let-it-flow/common-ui`
2. Import component: `import { CollapsibleStepTrace } from '@let-it-flow/common-ui'`
3. Import styles: `import '@let-it-flow/common-ui/styles'`
4. Wrap with `<details>` element using `.streaming-details` and `.streaming-summary` classes

## Design Rationale

### Problem Statement

- ai-content-factory and nexusops both implement similar "collapsible tool chain" components
- No unified platform-level streaming UI specification
- Each consumer app duplicates code for the same functionality

### Solution

Provide a common, reusable component and style library:
- Single source of truth for streaming UI patterns
- Consistent visual appearance across applications
- Easier to maintain and evolve

### Next Steps

1. ProcessTrace in @meso.ai/ui should support `showMetadata` parameter for simplification
2. ToolResult should include structured metadata (duration_ms, resultCount, etc.)
3. Consider CollapsibleToolTrace as a first-class component in @meso.ai/ui

## Future Enhancements

- [ ] CollapsibleToolTrace component in @meso.ai/ui
- [ ] ProcessTrace `showMetadata` parameter
- [ ] ToolResult metadata structure improvements
- [ ] Theme customization (light/dark mode)
- [ ] Animation preferences (respects prefers-reduced-motion)
