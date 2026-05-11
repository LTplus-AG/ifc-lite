---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Add "Merge Multilayer Walls" load-time toggle (issue #540).

When enabled, every `IfcBuildingElementPart` whose `IfcRelAggregates`
parent wall (a) has its own `Representation` and (b) is sliceable in
`MaterialLayerIndex` is suppressed during geometry emission. The parent
wall's single swept solid keeps the per-layer sub-mesh colouring via the
existing slicer, so the visual result on multilayer walls is the same as
the layered render — but with one mesh per wall instead of N per-layer
parts. Designed for large Revit-exported models where the per-layer
extrusions inflate vertex counts beyond what the viewer can handle.

New JS surface on `IfcAPI`:

```ts
setMergeLayers(enabled: boolean): void
```

Defaults to `false`. Honoured by `parseMeshes`, `parseMeshesSubset`,
`parseMeshesAsync`, `parseMeshesInstanced`, `parseMeshesInstancedAsync`,
`processGeometryBatch`, and `processGeometryBatchParallel`. The batch
paths cache the parts-to-skip set on `IfcAPI` so workers build it once
per content and reuse across every batch; the cache is cleared by
`clearPrePassCache` and by `setMergeLayers`.

Voids stay correct: `propagate_voids_to_parts` already copies the
parent wall's `IfcRelVoidsElement` references onto its layer parts in
the same pass that builds the part → parent map, so windows and doors
still cut through the merged solid.
