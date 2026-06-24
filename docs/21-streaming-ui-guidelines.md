# Streaming UI Design Guidelines

## Overview

This document establishes platform-level specifications for streaming execution display across let-it-flow consumer applications (ai-content-factory, nexusops, and future demos).

The design is inspired by Claude Code's approach: **keep main message flow clean and linear, hide process details by default, provide collapsible details panels for power users**.

---

## Design Principles

### 1. Main Flow Simplicity
- **Focus on results**: Display user input and final output prominently
- **Progressive disclosure**: Execution details hidden by default
- **Reading flow**: Linear top-to-bottom without interruption

**Example**:
```
User: "Generate a podcast episode on AI"
├─ Planning episode structure...
├─ Fetching reference materials...
└─ ✓ Episode generated (show summary)

[▼ Execution Details (42 steps)] ← Collapsible
```

### 2. Information Hierarchy
**Priority 1 (Always visible)**:
- User input and commands
- Key results and artifacts
- User interaction gates (confirmations, clarifications)

**Priority 2 (Collapsible)**:
- Tool execution details
- Parameters and arguments
- Execution timing
- Intermediate results

### 3. Execution Status Visibility
- **Current step**: Always shown with progress indicator
- **Completed steps**: Summarized (tool name + result count or status)
- **Full details**: Available on demand in collapsible panel

---

## Component Specifications

### CollapsibleStepTrace

Reusable platform component for displaying tool call chains.

**Location**: `@let-it-flow/common-ui/CollapsibleStepTrace`

**Props**:
```typescript
interface CollapsibleStepTraceProps {
  stream: StreamState;
}
```

**Rendering**:
```typescript
<details className="streaming-details">
  <summary className="streaming-summary">
    📋 执行细节 ({toolCallCount} 步操作)
  </summary>
  <CollapsibleStepTrace stream={stream} />
</details>
```

**Features**:
- Displays tool name, status (✓/✗/⟳), parameters, and results
- Color-coded status indicators (success=green, error=red, running=blue)
- Scrollable container with max-height constraint
- Graceful handling of empty tool call lists

---

## CSS Class Specification

All streaming UI elements use standardized class names from `@let-it-flow/common-ui/styles`:

| Class | Purpose | Notes |
|-------|---------|-------|
| `.streaming-details` | Collapsible container | HTML `<details>` element wrapper |
| `.streaming-summary` | Toggle button | HTML `<summary>` element styling |
| `.streaming-step-trace` | Tool call chain container | Flex column with scrolling |
| `.streaming-step-item` | Individual tool call | Has `data-status` attribute |
| `.streaming-step-header` | Tool name + status line | Flex row |
| `.streaming-step-args` | Parameters display | Collapsed by default |
| `.streaming-step-result` | Result/error display | Color-coded by status |

### Status Attributes

Tool call items use `data-status` to indicate execution state:

```html
<div class="streaming-step-item" data-status="done">
  ✓ web_search — 3 results
</div>

<div class="streaming-step-item" data-status="error">
  ✗ web_fetch — Connection timeout
</div>

<div class="streaming-step-item" data-status="running">
  ⟳ process_data — Processing...
</div>
```

### CSS Variables

Styles use design system variables for theming:

- `--color-bg` / `--color-bg-elevated` / `--color-bg-hover` — Background colors
- `--color-text-*` — Text colors (primary, secondary, muted)
- `--color-border*` — Border colors
- `--color-success` / `--color-error` / `--color-info` — Status colors

---

## Integration Guide

### For Consumer Applications

#### Step 1: Install dependency
```bash
npm install @let-it-flow/common-ui
```

#### Step 2: Import styles
In your main CSS file:
```css
@import "@let-it-flow/common-ui/styles";
```

#### Step 3: Add collapsible panel to LiveTrace
```typescript
import { CollapsibleStepTrace } from "@let-it-flow/common-ui";
import type { StreamState } from "@meso.ai/types";

export function LiveTrace({ stream, streaming }: { stream: StreamState; streaming: boolean }) {
  const toolCallCount = stream.toolCallOrder.length;
  
  return (
    <div className="live-trace">
      {/* Main execution display */}
      <ProcessTrace stream={stream} streaming={streaming} />
      
      {/* Collapsible execution details */}
      {toolCallCount > 0 && (
        <details className="streaming-details">
          <summary className="streaming-summary">
            📋 执行细节 ({toolCallCount} 步操作)
          </summary>
          <CollapsibleStepTrace stream={stream} />
        </details>
      )}
    </div>
  );
}
```

#### Step 4: Customize if needed (optional)
Add app-specific style overrides:
```css
/* App-specific tweaks */
.streaming-details {
  margin-top: 12px;
}
```

---

## Best Practices

### ✅ DO

- **Use collapsible details** for any execution trace with 5+ steps
- **Keep main flow focused** on user actions and results
- **Color-code by status** (green=success, red=error, blue=running)
- **Truncate long output** and allow expansion for details
- **Respect `prefers-reduced-motion`** in animations

### ❌ DON'T

- **Show all tool calls inline** in the main message flow
- **Display execution timing by default** (put in collapsible panel)
- **Use custom class names** — use platform standard `.streaming-*` classes
- **Break the linear reading flow** with interruptions
- **Assume 10+ tool calls are normal** — evaluate UI scalability

---

## Platform Recommendations for @meso.ai/ui

To better support this design pattern, we recommend the following enhancements to @meso.ai/ui:

### Recommendation 1: ProcessTrace Simplification Parameters ⭐ Priority: High

**Problem**: ProcessTrace displays all tool call details inline, consuming significant space.

**Proposed Solution**: Add configuration parameters to ProcessTrace:
```typescript
interface ProcessTraceProps {
  // Existing props...
  showMetadata?: boolean;       // false: hide parameters, timing, counts
  showResultSummary?: boolean;  // true: show only result summary
  compactMode?: boolean;        // true: single-line format
}
```

**Impact**: Allows consuming apps to simplify display without custom rendering.

### Recommendation 2: ToolResult Metadata Structure ⭐ Priority: High

**Problem**: ToolResult.output is unstructured string; metadata (duration, result count) cannot be extracted programmatically.

**Proposed Solution**: Add structured metadata field:
```typescript
interface ToolResult {
  output: string;
  error?: string;
  metadata?: {
    duration_ms?: number;
    resultCount?: number;
    category?: string;
    custom?: Record<string, unknown>;
  };
}
```

**Impact**: Enables consistent formatting of result summaries (e.g., "3 results", "completed in 250ms").

### Recommendation 3: CollapsibleToolTrace Component (Optional)

**Problem**: Multiple consumer apps implement similar "collapsible tool chain" components.

**Proposed Solution**: Provide built-in component in @meso.ai/ui:
```typescript
<CollapsibleToolTrace
  stream={stream}
  defaultExpanded="current"
  showMetadata={false}
/>
```

**Impact**: Single source of truth; easier maintenance and feature consistency.

---

## Implementation Checklist for New Consumer Apps

When building a new streaming application, use this checklist to ensure UI/UX consistency:

- [ ] Install `@let-it-flow/common-ui` dependency
- [ ] Import `@let-it-flow/common-ui/styles` in main CSS
- [ ] Use CollapsibleStepTrace component for tool execution details
- [ ] Use `.streaming-details` and `.streaming-summary` for collapsible panels
- [ ] Implement color-coded status indicators with `data-status` attributes
- [ ] Test collapsible open/close interaction
- [ ] Verify responsive layout on mobile and desktop
- [ ] Verify contrast and accessibility (WCAG AA)
- [ ] Test with 20+ tool calls to ensure scrolling/performance
- [ ] Document any app-specific style customizations

---

## Example: Complete Integration

```typescript
// src/components/LiveTrace.tsx
import { CollapsibleStepTrace } from "@let-it-flow/common-ui";
import { ProcessTrace, WorkflowTimeline } from "@meso.ai/ui";
import type { StreamState } from "@meso.ai/types";

export function LiveTrace({ 
  stream, 
  streaming,
  onToolConfirm,
  onToolCancel,
}: {
  stream: StreamState;
  streaming: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}) {
  const runs = stream.workflowRunOrder
    .map(id => stream.workflowRuns[id])
    .filter(Boolean);
  const toolCallCount = stream.toolCallOrder.length;

  return (
    <div className="live-trace">
      {/* Platform DAG visualization */}
      {runs.length > 0 && <WorkflowTimeline runs={runs} />}
      
      {/* Main execution flow (simplified) */}
      <ProcessTrace
        stream={stream}
        streaming={streaming}
        turnStreaming={stream.status === "streaming"}
        onToolConfirm={onToolConfirm}
        onToolCancel={onToolCancel}
      />
      
      {/* Collapsible execution details (platform component) */}
      {toolCallCount > 0 && (
        <details className="streaming-details">
          <summary className="streaming-summary">
            📋 执行细节 ({toolCallCount} 步操作)
          </summary>
          <CollapsibleStepTrace stream={stream} />
        </details>
      )}
    </div>
  );
}
```

```css
/* src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import platform streaming styles */
@import "@let-it-flow/common-ui/styles";

/* App-specific customizations */
.live-trace {
  margin: 8px 0;
}
```

---

## References

- [Claude Code Design](https://claude.ai/code) — Reference implementation
- [@let-it-flow/common-ui](../packages/common-ui/README.md) — Component library
- [@meso.ai/types](https://meso.ai) — Stream state types
- [@meso.ai/ui](https://meso.ai) — UI components

---

## Future Enhancements

- [ ] Dark mode support with prefers-color-scheme
- [ ] Reduced motion support with prefers-reduced-motion
- [ ] Keyboard navigation (arrow keys, Tab) for tool items
- [ ] Copy-to-clipboard for tool parameters and results
- [ ] Filter/search within collapsed execution details
- [ ] Export execution trace as JSON or Markdown
- [ ] Performance optimization for 100+ tool calls
