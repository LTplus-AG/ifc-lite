---
"@ifc-lite/viewer": patch
---

`markupTransitionPatch` now clears in-progress 2D markup placement and selection (`polygonArea2DPoints`, `cloudAnnotation2DPoints`, `measure2DStart`, `measure2DCurrent`, `selectedAnnotation2D`, `textAnnotation2DEditing`) on every real `activeModelId` transition, in addition to the five committed fields it already cached and restored per model. Previously only the committed fields moved with a model switch; an in-progress polygon, cloud outline, or measurement drawn against the outgoing model's coordinate frame carried over into the next model, so finishing it (e.g. `completePolygonArea2D`) computed a plausible but wrong result from points spanning two frames, and a `selectedAnnotation2D` could dangle at an id absent from the new model's arrays, making Delete a silent no-op.

`annotation2DActiveTool` is deliberately left out of this clear and still survives a model switch: it is a UI preference for which tool the next click uses, not a value computed from points in a coordinate frame, so there is nothing frame-dependent about it to discard.

`drawing2DSlice.markupTransition.test.ts` pins the six cleared fields across all three transition arms (null, cache-hit, cache-miss) and that `annotation2DActiveTool` is untouched; `drawing2DSlice.persistence.test.ts` and `teardown-registry.test.ts` continue to cover the five committed fields' cache/restore behaviour unchanged.
