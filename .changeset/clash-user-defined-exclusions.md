---
'@ifc-lite/clash': minor
---

Export `qualifiedKey` (the model-qualified element identity behind `pairKey`) and add `summarizeClashes`, which tallies a clash list into a `ClashSummary`. Both were already implemented internally: `qualifiedKey` lets a consumer build federation-safe pair identities without re-deriving the encoding, and `summarizeClashes` replaces the two private `buildSummary` copies in the TypeScript orchestrator and the duplicate scan, so a consumer that filters a `ClashResult` can rebuild its buckets the same way the engine does.

The viewer uses both for user-defined clash exclusions: a coordinator can now mark an overlap as by design, either for a whole IFC type pair or for one specific element pair, see how many clashes each rule is hiding, and remove or disable it. The rules persist in local storage and are applied to the last run without re-detecting.
