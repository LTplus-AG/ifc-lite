---
'@ifc-lite/viewer-embed': patch
---

Fix the embed bridge's `ISOLATE` postMessage command isolating a geometry-less `IfcElementAssembly` by its own id instead of its `IfcRelAggregates` parts, which blanked the embed viewport (#3338, the same shape #2531/#2532/#3382 fixed in five other channels).

Also adds `scripts/check-isolate-expansion-routing.mjs` (CI, "Node tests"): every `isolateEntities(` and `setIsolatedEntities(` call site under `apps/viewer` and `apps/viewer-embed` must either route through `cameraCallbacks.resolveHighlightIds` or be allowlisted with a reviewable reason, so a future channel that forgets the expansion fails CI instead of shipping a blank viewport.
