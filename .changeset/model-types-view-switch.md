---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Add a 3D **Model / Types** view switch (turns the #957 type geometry into a feature).

The viewer mesh path (`processGeometryBatch`) now always emits an `IfcTypeProduct`'s `RepresentationMap` geometry, tagging each mesh with a `geometryClass`: `0` = occurrence, `1` = orphan type (no occurrence — buildingSMART annex-E showcase files), `2` = instanced type-library shape (a type linked to an occurrence via `IfcRelDefinesByType`). `MeshDataJs.geometryClass` (wasm) and `MeshData.geometryClass` (`@ifc-lite/geometry`) carry it across the boundary.

The viewer's Visibility menu gains a Model/Types segmented control. **Model** (default) shows occurrences + orphan types and hides class‑2 type-library shapes — so the AC20/ArchiCAD "duplicate boxes at the wrong position" never appear. **Types** shows the type library (classes 1 + 2 at their map origins) and hides occurrences. The switch re-filters the cached mesh set instantly (no reload) and the choice persists across reloads.

The native `process_geometry` path is unchanged — it still suppresses instanced-type geometry so server/CLI/SDK exports never duplicate it.
