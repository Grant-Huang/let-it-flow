# Upstream Migration Plan: Common-UI → @meso.ai/ui

**Status**: Ready for Phase 3 implementation  
**Target**: Integrate CollapsibleStepTrace and streaming styles into @meso.ai/ui  
**Timeline**: Q3 2026  

---

## Executive Summary

The `@let-it-flow/common-ui` package contains reusable UI patterns that should ultimately reside in the upstream `@meso.ai/ui` library. This document outlines the migration strategy to:

1. **Short-term**: Mark components as "upstream-ready" in let-it-flow
2. **Medium-term**: Contribute to @meso.ai/ui and integrate
3. **Long-term**: Deprecate let-it-flow/common-ui and direct consumers to @meso.ai/ui

---

## Architecture Rationale

### Why CollapsibleStepTrace Belongs in @meso.ai/ui

**Not let-it-flow-specific**: 
- Works with any `StreamState` from `@meso.ai/types`
- Independent of let-it-flow's backend (Intent-to-DAG compiler)
- Applicable to any AI app that streams tool execution

**Not business logic**:
- Pure UI rendering of ToolCall chains
- No podcast, discovery, or domain-specific features
- Follows "Claude Code" pattern (universal design principle)

**Scope alignment**:
```
@meso.ai/ui: UI components for streaming AI execution
├─ ProcessTrace (full execution details)
├─ CollapsibleStepTrace (simplified execution details) ← belongs here
├─ WorkflowTimeline (DAG visualization)
└─ streaming.css (style specifications)

let-it-flow: Orchestration framework + reference implementations
├─ src/ (backend)
├─ docs/ (guidelines and specifications)
├─ apps/ (reference demos)
└─ packages/common-ui (temporary, until upstream integration)
```

---

## Phase 3: Preparation & Specification (Now)

### 3.1 Documentation

✅ **Created**:
- `docs/21-streaming-ui-guidelines.md` — Platform-level UI specification
- Architecture analysis (this document)

**Goals**:
- Establish consensus on upstream plan
- Create detailed specification for @meso.ai/ui team
- Prepare for Phase 4 implementation

### 3.2 Mark Common-UI as "Upstream-Ready"

Create metadata file:

```markdown
packages/common-ui/UPSTREAM_READY.md

# Upstream Integration Plan

This package contains patterns ready for upstream integration into @meso.ai/ui.

## Components to Migrate

### CollapsibleStepTrace
**Target name**: CollapsibleToolTrace (align with @meso.ai/ui naming)
**Files**: src/CollapsibleStepTrace.tsx
**Size**: ~100 LOC

**Proposed interface**:
```typescript
interface CollapsibleToolTraceProps {
  stream: StreamState;
  defaultExpanded?: 'all' | 'current' | 'none';
  showMetadata?: boolean;
}
```

### Streaming Styles
**Target**: @meso.ai/ui/styles/streaming.css
**Files**: src/streaming-ui.css
**Size**: ~300 LOC
**Variables**: Uses standard design system CSS variables

## Timeline
- Phase 3 (now): Specification and proposal
- Phase 4 (2-4 weeks): Implement in @meso.ai/ui
- Phase 5 (1 month): Integration and backward compatibility layer
- Phase 6: Deprecate and remove from let-it-flow

## Backward Compatibility Strategy
- Create re-export layer in let-it-flow (version N)
- Mark @let-it-flow/common-ui as deprecated
- Keep working for 2+ releases
- Users migrate to @meso.ai/ui directly (version N+2)

## Integration Notes for @meso.ai/ui Team
- CollapsibleToolTrace should pair with ProcessTrace
- Consider combined `<details>` wrapper handling
- Styling should use @meso.ai/ui design tokens
- Consider Recommendation 1: ProcessTrace simplification params
```

### 3.3 Validate Implementation

Test that current implementation is robust:

```bash
# Verify builds work
npm run build -w @let-it-flow/common-ui

# Verify consumers can import
npm run build -w @let-it-flow/ai-content-factory-web
npm run build -w @let-it-flow/nexusops-web

# Run tests (if applicable)
npm test
```

### 3.4 Prepare @meso.ai/ui Proposal

Detailed proposal for @meso.ai/ui team:

**Proposal: Add CollapsibleToolTrace Component**

**Summary**:
Let-it-flow has extracted a reusable pattern for collapsible tool execution display. We propose integrating this into @meso.ai/ui to complete the streaming UI toolkit.

**Rationale**:
- Multiple applications need simplified tool call display
- Current ProcessTrace is full-featured but information-dense
- "Collapsible details" pattern aligns with Claude Code design
- Reduces code duplication across consumer apps

**What we're proposing**:

1. **New component**: `CollapsibleToolTrace` (src/CollapsibleToolTrace.tsx)
   ```typescript
   <CollapsibleToolTrace stream={stream} showMetadata={false} />
   ```

2. **Enhanced styles**: Streaming-specific CSS spec (styles/streaming.css)
   ```css
   .streaming-details { /* collapsible container */ }
   .streaming-step-trace { /* tool chain */ }
   .streaming-step-item { /* individual tool */ }
   ```

3. **Integration point**: Pair with ProcessTrace
   ```typescript
   // Before: Full details always shown
   <ProcessTrace stream={stream} />
   
   // After: User can choose
   <ProcessTrace stream={stream} showMetadata={true} />  {/* full */}
   
   <details>
     <summary>Execution Details</summary>
     <CollapsibleToolTrace stream={stream} />  {/* simplified */}
   </details>
   ```

**Implementation effort**:
- CollapsibleToolTrace: ~150 LOC
- Styles: ~350 LOC
- Testing: ~100 LOC
- **Total**: ~600 LOC (low risk, pure presentation)

**Backward compatibility**: 
- Purely additive; no existing code breaks
- Works alongside current ProcessTrace
- Optional for consumers

---

## Phase 4: Upstream Integration (2-4 weeks)

### 4.1 Submit PR to @meso.ai/ui

```
Title: feat: Add CollapsibleToolTrace component for simplified execution display

Description:
- Adds CollapsibleToolTrace component for displaying tool call chains
- Includes comprehensive CSS specifications for streaming UI
- Enables "main flow clean, details on demand" pattern
- Pairs with ProcessTrace for complete streaming UI toolkit
```

**PR Contents**:
```
src/CollapsibleToolTrace.tsx          (150 LOC)
src/CollapsibleToolTrace.test.tsx    (100 LOC)
styles/streaming.css                 (350 LOC)
docs/CollapsibleToolTrace.md         (integration guide)
examples/collapsible-trace-demo.tsx  (usage example)
```

### 4.2 Review & Iteration

- Address @meso.ai/ui team feedback
- Align styling with design system
- Optimize performance for large tool chains (100+ tools)
- Document integration points

### 4.3 Release

- Merge into @meso.ai/ui
- Release as @meso.ai/ui@^3.1.0
- Update @meso.ai/ui README and examples

---

## Phase 5: Backward Compatibility Layer (1 month)

### 5.1 Create Re-Export in Let-it-Flow

Once @meso.ai/ui has released CollapsibleToolTrace:

```typescript
// packages/common-ui/src/index.ts (NEW VERSION)
/**
 * @deprecated since 0.2.0
 * Use @meso.ai/ui:CollapsibleToolTrace instead
 * 
 * This export is maintained for backward compatibility.
 * Will be removed in 0.4.0.
 */
export { 
  CollapsibleToolTrace as CollapsibleStepTrace 
} from "@meso.ai/ui";

export type { StreamState, ToolCallState } from "@meso.ai/types";
```

### 5.2 Update Consumer Apps (ai-content-factory, nexusops)

Option A: Keep using re-export (lazy migration)
```typescript
// Still works, but uses upstream version
import { CollapsibleStepTrace } from "@let-it-flow/common-ui";
```

Option B: Migrate to upstream directly
```typescript
// After one release cycle, update to:
import { CollapsibleToolTrace } from "@meso.ai/ui";
```

### 5.3 Version Management

**Let-it-flow version timeline**:
- v0.1.0: Original common-ui with CollapsibleStepTrace
- v0.2.0: Re-export layer (compatibility bridge)
- v0.3.0: Re-export layer + deprecation warnings
- v0.4.0+: Remove common-ui package entirely

---

## Phase 6: Cleanup (After stable period)

### 6.1 Consumer Dependency Update

```diff
// ai-content-factory/web/package.json
{
  "dependencies": {
-   "@let-it-flow/common-ui": "0.1.0",
+   "@meso.ai/ui": "^3.1.0"
  }
}

// ai-content-factory/web/src/components/renderLiveTrace.tsx
- import { CollapsibleStepTrace } from "@let-it-flow/common-ui";
+ import { CollapsibleToolTrace } from "@meso.ai/ui";

- <CollapsibleStepTrace stream={stream} />
+ <CollapsibleToolTrace stream={stream} />
```

### 6.2 Remove Common-UI from Let-it-Flow

```bash
# After Phase 6 stabilizes (usually 2-3 releases)
rm -rf packages/common-ui/

# Update root package.json
# - Remove @let-it-flow/common-ui from workspace
# - Update docs
# - Update CI/CD filters
```

### 6.3 Update Documentation

- `docs/21-streaming-ui-guidelines.md` — Update to reference @meso.ai/ui
- Create migration guide for other projects
- Archive this document as "completed migration"

---

## Timeline & Milestones

| Phase | When | What | Owner |
|-------|------|------|-------|
| 1 (Current) | Now | Phase 1-2 complete, docs written | let-it-flow |
| 3 | This week | Mark upstream-ready, prepare proposal | let-it-flow |
| 4 | 2-4 weeks | PR to @meso.ai/ui | let-it-flow |
| 4 | 4-8 weeks | Review & merge | @meso.ai |
| 5 | 8-12 weeks | Release @meso.ai/ui 3.1 | @meso.ai |
| 5 | 12-16 weeks | Re-export layer in let-it-flow 0.2 | let-it-flow |
| 6 | 20+ weeks | Consumers migrate (lazy) | let-it-flow/consumers |
| 6 | 24+ weeks | Remove common-ui | let-it-flow |

---

## Decision Points for @Meso.ai/ui Team

### Decision 1: Naming
- ✅ **Recommended**: CollapsibleToolTrace (aligns with "Tool" domain)
- Alternative: CollapsibleStepTrace (more generic)
- Alternative: SimpleToolTrace (implies simplified)

### Decision 2: Packaging
- ✅ **Recommended**: Include in main @meso.ai/ui package
- Alternative: Separate @meso.ai/ui-streaming package
- Alternative: Optional peer dependency

### Decision 3: Styling Strategy
- ✅ **Recommended**: Include streaming.css in @meso.ai/ui/styles
- Alternative: CSS modules for scoping
- Alternative: Tailwind or styled-components support

### Decision 4: Scope Creep
- Consider if this is good time to implement Recommendation 1 (ProcessTrace params)
- Consider if this enables future pattern (e.g., streaming analytics sidebar)

---

## Success Criteria

### Phase 3 ✅
- [x] Architecture analysis complete
- [x] Consensus on upstream plan
- [ ] Create UPSTREAM_READY.md marker
- [ ] Schedule meeting with @meso.ai/ui team

### Phase 4
- [ ] PR submitted to @meso.ai/ui
- [ ] CI passing on @meso.ai/ui
- [ ] Code review completed
- [ ] Merged and released

### Phase 5
- [ ] Re-export layer in let-it-flow 0.2
- [ ] Backward compatibility verified
- [ ] No breaking changes for consumers

### Phase 6
- [ ] All consumers migrated or notified
- [ ] common-ui removed from let-it-flow
- [ ] Documentation updated
- [ ] Archive migration complete

---

## Risk Mitigation

### Risk: @meso.ai/ui Doesn't Accept Contribution
**Mitigation**: 
- Ensure proposal is well-justified and spec'd out
- Provide reference implementation
- Offer to maintain on let-it-flow side if needed
- Plan fallback: Keep common-ui as permanent let-it-flow package

### Risk: Breaking Changes During Integration
**Mitigation**:
- Use semantic versioning carefully
- Extended beta period for phase 4
- Parallel implementation in let-it-flow until stable

### Risk: Consumers Resist Migration
**Mitigation**:
- Long compatibility period (2-3 releases)
- Auto-migration guide
- Keep re-export layer working

---

## References

- Phase 1-2 completion: Completed streaming UI consolidation
- Upstream recommendations: meso-ui-recommendations.md
- Platform guidelines: docs/21-streaming-ui-guidelines.md
- Common-UI package: packages/common-ui/

---

## Next Steps

### Immediate (This Week)
1. Review this plan with team
2. Create UPSTREAM_READY.md in packages/common-ui/
3. Schedule conversation with @meso.ai/ui team

### Short-term (Next Sprint)
1. Receive feedback from @meso.ai/ui
2. Refine proposal based on feedback
3. Begin Phase 4 implementation

### Medium-term (After Integration)
1. Create re-export layer (Phase 5)
2. Plan consumer migration
3. Set removal timeline

**Estimated total timeline**: 6 months (Phase 3-6)
