---
"@ifc-lite/diff": minor
---

Add `excludeTypes` to `diffModels` - a blacklist of IFC classes to leave out of the comparison entirely (issue #1470). An entity whose `ifcType` matches is dropped from both revisions before matching, so it never appears in `entries`, `byKey`, or `counts`. This is how the viewer's Compare panel lets a user ignore connective noise like `IfcOpeningElement` (the void a removed window leaves behind), which reads as a spurious deletion on its own. Matching is case-insensitive and trims whitespace; the applied, normalized blacklist is echoed on the result as `ModelDiff.excludedTypes` (empty when nothing was excluded). Backward compatible: omitting `excludeTypes` is unchanged behaviour.
