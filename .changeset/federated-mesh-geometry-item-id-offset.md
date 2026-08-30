---
'@ifc-lite/viewer': patch
---

Re-home `MeshData.geometryItemId` — and the instanced occurrence's `itemId` beside it — by the federation id offset, so a federated model's source representation item cannot resolve to a real entity in the wrong model.

The loader's federated finalize shifted `expressId` and, since #1781, `textureRef.textureId` into the model's global id range, and left `geometryItemId` (the `IfcRepresentationItem` a mesh was tessellated from, #2985/#3199) in the model's local space on the same mesh. Resolution back to (model, expressId) in the viewer is range-based — `FederationRegistry.fromGlobalId`/`getModelForGlobalId` and `modelSlice.resolveGlobalIdFromModels` all ask which model's id range contains the number — so an unshifted item id from a model loaded at offset 1,000,000 is a small number that lands inside the primary model's range. It did not miss and it did not throw: it resolved to a real entity in the wrong model, which nothing downstream can tell from a correct answer.

The instanced path moves with it. `Scene.getInstancedMeshDataPieces` is already called with a global id (`useZoneGeometrySplit`, `useZoneApportionment`) and stamps an occurrence's `itemId` onto the materialized piece's `geometryItemId`, so shifting only the flat path would feed the same field a local number through the other door. Both shifts guard absence explicitly: the field is optional and legitimately absent, and it must not become `NaN` (`undefined + offset`) or the bare offset (`(x ?? 0) + offset`), which is itself a resolvable wrong answer.

`MeshData.materialId`, the other source id added in #3199, is an `IfcMaterial` express id with the same gap and is deliberately not touched here.
