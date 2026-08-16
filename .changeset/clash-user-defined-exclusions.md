---
'@ifc-lite/clash': minor
---

Export `qualifiedKey` (the model-qualified element identity behind `pairKey`) and add `summarizeClashes`, which tallies a clash list into a `ClashSummary`. Both were already implemented internally: `qualifiedKey` lets a consumer build federation-safe pair identities without re-deriving the encoding, and `summarizeClashes` replaces the two private `buildSummary` copies in the TypeScript orchestrator and the duplicate scan, so a consumer that filters a `ClashResult` can rebuild its buckets the same way the engine does.

The viewer uses `summarizeClashes` for user-defined clash exclusions: a coordinator can now mark an overlap as by design in three ways: a whole IFC type pair, a ONE-SIDED type rule that excludes every clash involving one type regardless of what it meets, or one specific element pair, see how many clashes each rule is hiding, and remove or disable it. The rules persist in local storage and are applied to the last run without re-detecting. `qualifiedKey` is exported for external consumers but is not called from the viewer itself, which keys exclusion rules on the durable element key alone (see `apps/viewer/src/lib/clash/exclusions.ts`).
