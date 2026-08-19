---
"@ifc-lite/clash": patch
"@ifc-lite/viewer": patch
---

Fix clash detection silently skipping every GPU-instanced entity.

`useClash` built its clash elements from `model.geometryResult.meshes` alone, which excludes every entity whose geometry was fully GPU-instanced — anything repeated 8 or more times (`INSTANCE_MIN_OCCURRENCES` in the wasm mesher). Doors, windows, columns, sprinklers, light fittings, and other repeated components vanished from clash detection with no error, no warning, and no count discrepancy: the report simply came back short.

`gatherElements` now restores those entities with `withInstancedMeshes` — the same helper the glTF/IFC5 export path already uses (#2558/#2576) to reach instanced-only geometry through `Scene.getAllInstancedMeshData()`. This surfaces real triangles from the live renderer scene, not an AABB approximation, so a clash reported off an instanced entity is exactly as exact as one reported off a flat mesh. It applies to the primary model only (instanced shard ids live in the primary model's id space), matching every existing call site of the helper.

`elementsFromStep` (`@ifc-lite/clash`) now also keys an element's identity on `MeshData.occurrenceKey` when present, so distinct physical occurrences of one GPU-instanced expressId no longer collapse onto a single review/exclusion key, and a relationship-derived exclusion (void/host, assembly) fans out to every occurrence sharing that expressId instead of only the last one built.
