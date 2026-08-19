---
"@ifc-lite/clash": patch
"@ifc-lite/viewer": patch
---

Fix clash detection silently skipping every GPU-instanced entity.

`useClash` built its clash elements from `model.geometryResult.meshes` alone, which excludes every entity whose geometry was fully GPU-instanced — anything repeated 8 or more times (`INSTANCE_MIN_OCCURRENCES` in the wasm mesher). Doors, windows, columns, sprinklers, light fittings, and other repeated components vanished from clash detection with no error, no warning, and no count discrepancy: the report simply came back short.

`gatherElements` now restores those entities with `withInstancedMeshes` — the same helper the glTF/IFC5 export path already uses (#2558/#2576) to reach instanced-only geometry through `Scene.getAllInstancedMeshData()`. This surfaces real triangles from the live renderer scene, not an AABB approximation, so a clash reported off an instanced entity is exactly as exact as one reported off a flat mesh.

This also covers federated models. `withInstancedMeshes` used to gate on `isPrimary` and no-op for every non-primary model — correct when it was written, but GPU instancing stopped being primary-only once federated models got instanced shards too (#2255), and the gate was never updated, so a federated model's own instanced entities were silently skipped for both clash and every glTF/IFC5/KMZ export call site. The helper now takes this model's `{ idOffset, maxExpressId }` id-range bracket instead of a boolean, scoping `getAllInstancedMeshData()`'s all-models output down to just this model's occurrences — restoring a federated model's own instanced entities without a federation of N models double-counting each other's.

`elementsFromStep` (`@ifc-lite/clash`) now also keys an element's identity on `MeshData.occurrenceKey` when present, so distinct physical occurrences of one GPU-instanced expressId no longer collapse onto a single review/exclusion key, and a relationship-derived exclusion (void/host, assembly) fans out to every occurrence sharing that expressId instead of only the last one built.
