---
"@ifc-lite/geometry": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Add DFJSON (Dragonfly) energy-model export alongside HBJSON. Each `IfcSpace` becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height) grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall models. Surfaces:

- `GeometryProcessor.exportDfjson(buffer, name)` (`@ifc-lite/geometry`)
- `bim.export.dfjson({ name, filename })` + `ExportDfjsonOptions` (`@ifc-lite/sdk`)
- `ifc-lite export <file> --format dfjson` (`@ifc-lite/cli`)

The Rust source of truth is `ifc-lite-export::export_dfjson`, reusing the same analytic floor-footprint extraction as HBJSON, so the two exports agree on where a footprint lands.

They do not cover the same set of spaces, by design: each builder applies its own admissibility rules downstream of that shared extraction. DFJSON drops a space whose extrusion is (near-)horizontal, because a tilted prism has no faithful `Room2D`, where HBJSON still emits a solid; conversely DFJSON keeps a space that HBJSON's watertightness gate rejects, since a 2D plate has nothing to fail. On real models that runs in both directions — 19 HBJSON rooms vs 17 DFJSON on one file, 46 vs 47 on another.

Two known v1 limitations: there is no `dedupe_colliding` pass, so a model carrying duplicated `IfcSpace` geometry (Revit does this) yields overlapping `Room2D`s and double-counted floor area; and stories are grouped by an elevation-band heuristic rather than by `IfcBuildingStorey` containment, with all buildings collapsed into one.

Both energy exports apply the mutation view, so entities authored in-session (drawn spaces, in particular) are visible to the analytic exporter rather than silently missing — the DFJSON half of #1908. Regeneration through `StepExporter` happens only when the overlay actually carries edits (`hasPendingChanges()`), so an unedited model still hands its retained source bytes straight to the exporter. The gate, the byte resolution and the WASM handle lifecycle are shared between the two formats rather than written twice.
