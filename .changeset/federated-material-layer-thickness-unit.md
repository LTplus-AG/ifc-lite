---
'@ifc-lite/parser': minor
---

Fix `extractMaterialsOnDemand`/`extractAllMaterialsOnDemand` scaling an `IfcMaterialLayer.LayerThickness` by the wrong project's length unit in a multi-`IfcProject` file — the shape `MergedExporter`'s default `unitReconciliation: 'auto'` produces when it federates a model whose length unit differs from the first model's (kept in its own `IfcProject`/`IfcUnitAssignment` rather than rescaled, per that module's docs).

The thickness scale came from `store.lengthUnitScale`, which `extractLengthUnitScale` resolves for the file's FIRST `IfcProject` only — correct for an ordinary single-project file, wrong for a layer belonging to a LATER project. A federated millimetre model's 300&nbsp;mm layer, read back through a merged file whose first project is metres, came back as a fabricated "300 m" one instead of 0.3 m.

Adds `resolveEntityLengthUnitScale(source, entityIndex, relationships, expressId)`: for the common single-project file it is identical to `extractLengthUnitScale` (no behaviour change); for a multi-project file it walks the entity's real spatial containment (`IfcRelContainedInSpatialStructure` / `IfcRelAggregates`, and `IfcRelDefinesByType` for a type-level material assignment) up to its OWN owning `IfcProject` and answers for that project's declared unit, rather than guessing from express-id ordering.
