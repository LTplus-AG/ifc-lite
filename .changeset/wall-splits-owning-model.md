---
"@ifc-lite/viewer": patch
---

Splitting or duplicating an element in a non-active federated model no longer files the new geometry under the active model. `appendGeometryBatch` now requires the owning model id explicitly instead of assuming the active model, so a wall/slab split's new halves, a duplicated element's clone, and streamed-in geometry all land on the model that owns them — keeping per-model triangle/vertex totals, exports, and bounds consistent (#4922).
