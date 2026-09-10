# Federated immutable mesh replacement (#4451)

The real AC20 fixture was loaded twice through the viewer file input. The second model received the in-progress #4404 evaluated slab appearance conversion, which removes its opening render shape while preserving IFC relationships. This integration setup is additional evidence for the cache fix; the F6 conversion policy remains a separate, unmerged change.

Before the cache fix, Undo published the original slab item 1138382 to the canonical model but the merged scene retained converted item 1158217 after showing openings. Redo correctly refused that stale geometry. The cache treated an immutable list replacement which also restored an opening as a streaming append.

With the fix, the complete real WebGPU journey passed: preview/compare/apply, hidden Undo/Redo, show openings, Undo, actual viewport click selecting restored opening 1138473, Redo and IFCZIP export. `browser.json` records source/runtime identity and geometry hashes; the screenshots show the restored selectable opening and final textured slab.

The isolated mounted hook regressions pass all three cases. Removing only the source-identity invalidation makes the two replacement cases fail while the append control still passes. They also cover equal-length replacement and unchanged-array streaming append; those do not depend on the unmerged F6 policy. No normal-load performance claim is made: this viewer-only change preserves the existing incremental path and rebuilds when immutable model geometry is replaced.
