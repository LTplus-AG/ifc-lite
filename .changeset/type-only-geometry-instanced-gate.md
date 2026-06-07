---
"@ifc-lite/wasm": patch
---

Fix duplicate geometry rendered at wrong positions for ArchiCAD/AC20-style IFC files (regression from #957/#962 "type-only geometry").

The #957 orphan-`IfcTypeProduct` pass rendered a type's `IfcRepresentationMap` whenever no `IfcMappedItem` referenced it. But real-world exporters (e.g. ArchiCAD AC20: `AC20-FZK-Haus`, `C20-Institute-Var-2`) attach a `RepresentationMap` to nearly every door/window/furniture **type** while the **occurrence** carries its own direct body geometry — the type and occurrence are linked only by `IfcRelDefinesByType`, so the map is referenced by no `IfcMappedItem`. Every such type was therefore mis-classified as "orphan" and double-rendered at its `MappingOrigin`, producing a cluster of duplicate boxes at the wrong position (e.g. ~140 spurious meshes in `AC20-FZK-Haus`).

Type-only geometry is now rendered only when the type has **no occurrence** — i.e. it is not the `RelatingType` of any `IfcRelDefinesByType`. The genuinely-orphan buildingSMART annex-E "tessellated shape with style" case (a type with no occurrence) still renders. Fixed across both mesh pipelines (the native `process_geometry` path and the viewer `buildPrePass*` + `processGeometryBatch` path) plus the render-time gate, with regression tests on both.
