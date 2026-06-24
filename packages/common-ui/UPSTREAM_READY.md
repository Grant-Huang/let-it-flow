# Upstream Integration Status

**Current Status**: ✅ Ready for upstream (@meso.ai/ui) integration  
**Target Library**: @meso.ai/ui@^3.1.0  
**Timeline**: Phase 4-5 (Q3 2026)  

---

## Why This Package is Upstream-Ready

This package contains **reusable streaming UI patterns** that are not specific to let-it-flow. They should ultimately live in the upstream `@meso.ai/ui` library to benefit all AI applications.

### Criteria Met

✅ **Not platform-specific**: Works with any `StreamState` from `@meso.ai/types`  
✅ **No business logic**: Pure UI rendering of tool execution chains  
✅ **Tested pattern**: Validated across ai-content-factory and nexusops  
✅ **Well-documented**: Comprehensive README and guidelines  
✅ **No breaking deps**: Only depends on @meso.ai/ui and @meso.ai/types  
✅ **Universal benefit**: Applicable to any AI app with streaming execution  

---

## Components Ready for Migration

### 1. CollapsibleStepTrace Component

**Current location**: `src/CollapsibleStepTrace.tsx`  
**Proposed name in upstream**: `CollapsibleToolTrace`  
**Size**: ~100 LOC  
**Dependencies**: @meso.ai/types (StreamState, ToolCallState)  

**Purpose**: Display tool call chains in a collapsible panel with simplified details.

**Key features**:
- Color-coded status indicators (✓/✗/⟳)
- Truncated parameters and results
- Scrollable container
- Graceful empty state handling

**Proposed interface**:
```typescript
interface CollapsibleToolTraceProps {
  stream: StreamState;
  defaultExpanded?: 'all' | 'current' | 'none';  // Default: 'none'
  showMetadata?: boolean;                         // Default: false
  maxHeight?: string;                             // Default: '400px'
}

export function CollapsibleToolTrace(props: CollapsibleToolTraceProps): JSX.Element;
```

### 2. Streaming UI Styles Specification

**Current location**: `src/streaming-ui.css`  
**Proposed location in upstream**: `styles/streaming.css`  
**Size**: ~350 LOC  

**Purpose**: Standardized CSS classes for streaming execution display.

**Covers**:
- `.streaming-details` — Collapsible container styling
- `.streaming-summary` — Toggle button styling
- `.streaming-step-trace` — Tool chain container
- `.streaming-step-item` — Individual tool call
- `.streaming-step-header` — Tool name + status line
- `.streaming-step-args` — Parameters display
- `.streaming-step-result` — Result/error display

**Design features**:
- Uses CSS custom properties for theming
- Responsive and accessible
- Dark mode support
- Scrollbar styling for long lists

### 3. Comprehensive Documentation

**Current location**: `README.md`  
**Includes**:
- Design principles (Claude Code pattern)
- Component API reference
- CSS class specifications
- Integration guide for new apps
- Design rationale

---

## Migration Strategy

### Phase 3: Specification (Now)
- ✅ Create this document
- ✅ Document upstream integration plan
- ✅ Validate component quality
- ⏳ Schedule @meso.ai/ui team discussion

### Phase 4: Upstream Integration (2-4 weeks)
- [ ] Submit PR to @meso.ai/ui with CollapsibleToolTrace
- [ ] Address review feedback
- [ ] Merge and release as @meso.ai/ui@^3.1.0

### Phase 5: Backward Compatibility (1 month)
- [ ] Create re-export in let-it-flow/common-ui
- [ ] Keep working for existing consumers
- [ ] Mark as deprecated

### Phase 6: Cleanup (After stable period)
- [ ] Update consumer apps to use @meso.ai/ui directly
- [ ] Remove this package from let-it-flow
- [ ] Archive migration documentation

---

## Technical Readiness

### Code Quality
- ✅ TypeScript with full type safety
- ✅ No external dependencies beyond @meso.ai libraries
- ✅ Proper error handling
- ✅ Helper functions for common operations (truncate, summarize)

### Performance
- ✅ Scrollable container with max-height constraint
- ✅ Efficient DOM rendering with React keys
- ✅ No unnecessary re-renders

### Accessibility
- ✅ Semantic HTML (`<details>`, `<summary>`)
- ✅ Color contrast meets WCAG AA
- ✅ Keyboard navigable
- ✅ Screen reader friendly

### Browser Support
- ✅ Modern browsers (Chrome, Firefox, Safari, Edge)
- ✅ Uses standard CSS (no vendor prefixes needed)
- ✅ Graceful degradation for older browsers

---

## Proposed PR to @meso.ai/ui

**Title**: `feat: Add CollapsibleToolTrace component for simplified streaming UI`

**Description**:
```
Add a new component for displaying simplified tool execution chains,
enabling "main flow clean, details on demand" pattern inspired by 
Claude Code.

This complements ProcessTrace by providing a lightweight alternative
for scenarios where full execution details should be hidden by default.

Features:
- Color-coded status indicators (✓/✗/⟳)
- Collapsible details with <details>/<summary>
- Truncated parameters and results
- Scrollable container for large tool chains
- Comprehensive CSS specifications

Pairs with ProcessTrace for complete streaming UI toolkit:
- ProcessTrace: Full details always visible
- CollapsibleToolTrace: Simplified, collapsible details

Includes comprehensive documentation and usage examples.
```

**Files in PR**:
```
src/CollapsibleToolTrace.tsx          (~100 LOC) - Component
src/CollapsibleToolTrace.test.tsx     (~100 LOC) - Unit tests
styles/streaming.css                  (~350 LOC) - Style specifications
docs/CollapsibleToolTrace.md          (~200 LOC) - Integration guide
examples/collapsible-trace-demo.tsx   (~100 LOC) - Usage example
```

---

## Integration Points in @meso.ai/ui

### Recommended Usage Pattern
```typescript
import { ProcessTrace, CollapsibleToolTrace } from "@meso.ai/ui";

// Option 1: Full details
<ProcessTrace stream={stream} streaming={streaming} />

// Option 2: Simplified + collapsible (recommended for main flows)
<ProcessTrace stream={stream} streaming={streaming} showMetadata={false} />
<details className="streaming-details">
  <summary className="streaming-summary">
    📋 执行细节 ({stream.toolCallOrder.length} 步)
  </summary>
  <CollapsibleToolTrace stream={stream} />
</details>
```

### Export Path
```typescript
// @meso.ai/ui/index.ts (or @meso.ai/ui/streaming)
export { CollapsibleToolTrace } from "./CollapsibleToolTrace";
export { /* streaming CSS classes */ };
```

---

## Future Enhancements (Post-Integration)

After CollapsibleToolTrace is integrated into @meso.ai/ui, consider:

1. **ProcessTrace enhancement** (Recommendation 1)
   - Add `showMetadata`, `showResultSummary`, `compactMode` parameters
   - Enable consumers to simplify full execution display

2. **ToolResult metadata** (Recommendation 2)
   - Structured metadata field for duration, result count, category
   - Enable consistent result summary formatting

3. **Performance optimizations**
   - Virtual scrolling for 100+ tool calls
   - Lazy rendering of tool details
   - Memoization for large streams

4. **Analytics integration**
   - Tool execution statistics sidebar
   - Timeline view of concurrent executions
   - Performance metrics per tool

---

## Communication Timeline

### Week 1-2: Proposal Phase
- [ ] Send this document to @meso.ai/ui team
- [ ] Schedule architecture review meeting
- [ ] Get feedback on naming and scope

### Week 3-4: Specification Phase
- [ ] Refine based on @meso.ai/ui feedback
- [ ] Align on implementation details
- [ ] Prepare PR with full documentation

### Week 5-8: Implementation Phase
- [ ] Submit PR to @meso.ai/ui
- [ ] Address code review feedback
- [ ] Iterate on design decisions

### Week 9-12: Release Phase
- [ ] Merge into @meso.ai/ui
- [ ] Release as @meso.ai/ui@^3.1.0
- [ ] Update documentation

---

## Deprecation Notice

Once upstream integration is complete, this package will be marked as:

```typescript
/**
 * @deprecated since 0.2.0
 * @see {@link https://github.com/meso-ai/meso-ai-ui} for CollapsibleToolTrace
 * 
 * This package is maintained for backward compatibility only.
 * Please migrate to @meso.ai/ui:CollapsibleToolTrace.
 * 
 * This package will be removed in 0.4.0.
 * See docs/22-upstream-migration-plan.md for migration guide.
 */
```

---

## References

- Architecture analysis: ../docs/22-upstream-migration-plan.md
- Platform guidelines: ../docs/21-streaming-ui-guidelines.md
- Let-it-flow streaming UI: ../
- Upstream library: https://github.com/meso-ai/meso-ai-ui

---

## Contact

For questions about upstream integration:
- Email: jacer.huang@gmail.com
- Issue: github.com/grant-huang/let-it-flow/issues
- Discussion: github.com/grant-huang/let-it-flow/discussions
