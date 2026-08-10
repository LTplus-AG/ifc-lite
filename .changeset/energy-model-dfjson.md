---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Add DFJSON (Dragonfly) energy-model export alongside HBJSON. Each `IfcSpace` becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height) grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall models. Surfaces:

- `GeometryProcessor.exportDfjson(buffer, name)` (`@ifc-lite/geometry`)
- `bim.export.dfjson({ name, filename })` + `ExportDfjsonOptions` (`@ifc-lite/sdk`)
- `ifc-lite export <file> --format dfjson` (`@ifc-lite/cli`)

The Rust source of truth is `ifc-lite-export::export_dfjson`, reusing the same analytic floor-footprint extraction as HBJSON, so the two exports agree on where a footprint lands.

They do not cover the same set of spaces, by design: each builder applies its own admissibility rules downstream of that shared extraction. A `Room2D` is a floor polygon swept straight up, so DFJSON reports a space as `skipped` when it cannot be represented that way — a zero-height extrusion, an extrusion that leans more than ~2° off vertical, or a sloped floor ring — where HBJSON still emits a solid. Emitting those as vertical plates anyway would land the floor correctly and every wall wrongly, with nothing in the stats to say so. Conversely DFJSON keeps a space that HBJSON's watertightness gate rejects, since a 2D plate has nothing to fail. On real models that runs in both directions — 19 HBJSON rooms vs 17 DFJSON on one file, 46 vs 47 on another.

A model carrying duplicated `IfcSpace` geometry (Revit does this) runs the same `dedupe_colliding` pass HBJSON uses, so overlapping plates drop the same copies rather than double-counting floor area.

The `Building` → `Story` → `Room2D` nesting comes from the file's own `IfcBuilding` / `IfcBuildingStorey` / `IfcSpace` containment, and both carry their IFC `Name` into `display_name` — the point of the format for an IFC-shaped model, and the thing HBJSON's flat `rooms` array drops. Grouping by floor elevation instead would only approximate the partition the file already states: on `Office_A_20110811.ifc` a 1 m elevation band splits the model's two populated storeys into three stories. That heuristic survives as the fallback for spaces the file places nowhere, and for models that declare no spatial structure at all.

Known v1 limitation: `Room2D.display_name` is still `R{expressId}` rather than the `IfcSpace` `Name` — the same as HBJSON's rooms today, so the two stay in step.

Both energy exports apply the mutation view, so entities authored in-session (drawn spaces, in particular) are visible to the analytic exporter rather than silently missing — the DFJSON half of #1908. Regeneration through `StepExporter` happens only when the overlay actually carries edits (`hasPendingChanges()`), so an unedited model still hands its retained source bytes straight to the exporter. The gate, the byte resolution and the WASM handle lifecycle are shared between the two formats rather than written twice.
