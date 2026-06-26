---
"@ifc-lite/export": minor
---

Make `MergedExporter` unit-aware so federating models with different length units no longer mis-scales geometry, and reconcile shared GlobalIds instead of emitting duplicates (#1332).

Previously the merge folded every model into the first model's `IfcProject` and deduplicated its `IfcUnitAssignment`, so a second model's raw coordinates were silently reinterpreted under the first model's unit (e.g. a metre model read as feet, ≈3.28x off). Models that reused the same `GlobalId` for `IfcSite`/`IfcBuilding`/`IfcBuildingStorey` or products also produced duplicate-entity errors in strict viewers.

Now:

- A model that shares the first model's length unit is unified as before (single project, spatial structure and infrastructure deduplicated).
- A model with a different length unit is **federated**: it keeps its own `IfcProject`, `IfcUnitAssignment` and representation contexts, so its coordinates stay correctly scaled. The output then contains more than one `IfcProject` only when units actually differ — an intentional, flagged relaxation of the `IfcSingleProjectInstance` rule that is strictly better than the previous silent mis-scale.
- GlobalIds are reconciled, not blindly duplicated: a non-relationship rooted entity repeating a GlobalId already emitted **in the same unit space** is unified to the one instance. Otherwise it is kept and re-stamped with a fresh deterministic GlobalId — this preserves objectified relationships (`IfcRel*`), whose membership can differ even when the GlobalId matches, and prevents a unit-compatible model from being unified onto a federated (different-unit) instance.
- Resource entities whose Name is coincidentally a 22-character GlobalId-charset string (properties, quantities, materials, styles, …) are no longer mistaken for rooted entities, so their values and names are never dropped or overwritten.

The model's unit scale is read from `dataStore.lengthUnitScale` automatically. New `MergeModelInput.lengthUnitScale` lets callers override it, and a new `MergeExportOptions.unitReconciliation: 'auto' | 'assume-shared'` option (default `'auto'`) can force the pre-1332 single-project behaviour when the caller has already normalised units. `MergeExportResult.stats` now also reports `federatedModelCount` and `warnings` (the latter flags the multi-`IfcProject` conformance trade-off); the CLI `merge` command prints these warnings.
