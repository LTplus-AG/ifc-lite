---
"@ifc-lite/renderer": patch
---

Fix cross-model geometry picking: clicking near a batched mesh could select an element from a different federated model than the one actually under the ray.

`RaycastEngine.collectVisibleMeshData`'s batched-mesh loop looked up candidate geometry with `getMeshDataPieces(expressId)` and no model scope, so when two federated models shared an expressId (a routine occurrence — expressIds are only unique within their own IFC file), the candidate set for a pick silently included every model's pieces for that id, not just the one the batch entry actually belonged to. Batches group by colour, not by model, so two models sharing an expressId and colour can land in the very same batch as distinct entries.

`BatchedMesh` now carries `modelIndices`, parallel to its existing `expressIds` array, populated per entry when `Scene.createBatchedMesh` builds the batch. The raycast engine's batched-mesh loop scopes each entry to its own model index the same way the regular-mesh loop already did, so a pick can only ever resolve to geometry that entry's own model actually owns.
