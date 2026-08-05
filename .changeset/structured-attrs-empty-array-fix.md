---
"@ifc-lite/collab": patch
---

Fix a snapshot -> seed round trip silently dropping an explicitly-cleared `classifications` or `materials` attribute.

`inflateStructuredAttributes` (`packages/collab/src/snapshot/structured-attrs.ts`) shape-gated these attributes with `Array.isArray(value) && value.every(isClassificationRefShaped)` (same for materials). `[].every(...)` is vacuously true, so an entity whose classifications/materials were explicitly cleared to `[]` passed the gate, got pulled out of the flat attributes into the structured branch, and `flattenStructuredBranches` only re-emits that branch when it's non-empty — so the key never came back on the next snapshot. A reader who took a snapshot after the clearing landed would see the attribute vanish entirely rather than resolve to `[]`, and could keep serving a stale non-empty value from before the clear. Both branches now require a non-empty array before taking the structured path (mirroring the existing `geometryRefs` guard), so an explicit `[]` stays in the flat attributes and survives the round trip.
