---
"@ifc-lite/geometry": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Add DFJSON (Dragonfly) energy-model export alongside HBJSON. Each `IfcSpace` becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height) grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall models. Surfaces:

- `GeometryProcessor.exportDfjson(buffer, name)` (`@ifc-lite/geometry`)
- `bim.export.dfjson({ name, filename })` + `ExportDfjsonOptions` (`@ifc-lite/sdk`)
- `ifc-lite export <file> --format dfjson` (`@ifc-lite/cli`)

The Rust source of truth is `ifc-lite-export::export_dfjson`, reusing the same analytic floor-footprint extraction as HBJSON so the two energy exports cannot drift on coverage.

Both energy exports apply the mutation view, so entities authored in-session (drawn spaces, in particular) are visible to the analytic exporter rather than silently missing — the DFJSON half of #1908. Regeneration through `StepExporter` happens only when the overlay actually carries edits (`hasPendingChanges()`), so an unedited model still hands its retained source bytes straight to the exporter. The gate, the byte resolution and the WASM handle lifecycle are shared between the two formats rather than written twice.
