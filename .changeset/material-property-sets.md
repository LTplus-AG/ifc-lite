---
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
---

feat(materials): expose material property sets and a Materials inspector tab

Material property sets attached to an `IfcMaterial` via `IfcMaterialProperties`
(e.g. `Pset_MaterialConcrete`) are now resolved and shown:

- **On the selected object** — a "Material Properties" group in the inspector,
  resolved through the element's material association (fanning a layer / profile /
  constituent set out to each member material), mirroring how type psets surface
  on an occurrence.
- **A new "Materials" hierarchy tab** — lists every base material; selecting one
  isolates its elements and shows the material's own psets plus quantities
  (volume / area / weight) aggregated across all using elements, apportioned by
  each element's material share (layer thickness / constituent fraction).

New parser exports: `extractMaterialPropertiesOnDemand`,
`extractMaterialPropertiesForMaterialId`, `buildMaterialUsageIndex`,
`collectMaterialLeaves`, `resolveMaterialDefId`, `getMaterialDisplay`, and the
`MaterialPsetGroup` / `MaterialLeaf` / `MaterialUsage` types.
