---
"@ifc-lite/export": patch
---

Demesher follow-ups: `applySimplifiedGeometry` now replaces a repeated express id once and skips duplicates with a `duplicate-id` reason (a second overlay chain would be orphaned bloat); the prune mark-and-sweep moved to its own module (`demesh-prune.ts`); documented the complete-`entityIndex.byId` requirement and the triangle-count-vs-bytes expectation for `ifc-lite simplify`.
