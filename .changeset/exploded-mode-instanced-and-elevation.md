---
"@ifc-lite/renderer": patch
"@ifc-lite/parser": patch
---

Fix Exploded level-display mode leaving geometry behind (#1289).

Two independent defects made Exploded mode look broken:

- GPU-instanced occurrences (repeated geometry emitted via `IfcMappedItem`, e.g.
  windows / mullions) were never lifted with their storey, because the per-entity
  translate only touched the flat `meshDataMap` and not the instanced shard. They
  stayed at their native elevation while the rest of the storey rose ("objects
  left behind"). `Scene.translateInstancedEntity` now shifts each occurrence's
  transform in both the CPU instance record and the GPU buffer, plus its cached
  world AABB, so pick / measure / section / export stay correct. This also fixes
  moving an instanced element with the gizmo.

- A storey whose `Elevation` attribute is null (common in Revit / ArchiCAD
  exports) was dropped from the elevation map, so Exploded mode had a single
  floor to order ("only one floor"). The spatial-hierarchy builder now falls back
  to the storey's `ObjectPlacement` Z when the attribute is missing.
