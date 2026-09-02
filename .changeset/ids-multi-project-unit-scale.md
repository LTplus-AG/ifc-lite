---
'@ifc-lite/ids': patch
---

Fix IDS `<property>`/`<quantity>` requirements evaluating a length/area/volume value against the wrong project's declared unit scale on a file with more than one `IFCPROJECT`.

A multi-`IFCPROJECT` file is not malformed — `MergedExporter`'s documented `auto` unit-reconciliation mode (issue #1332) legitimately produces one when federating models that declare different length units, keeping each source model's own `IFCPROJECT`/`IFCUNITASSIGNMENT` rather than rescaling raw values. `collectAllPropertySets` (`packages/ids/src/bridge/properties.ts`) read a single `store.lengthUnitScale` — resolved once, from the file's FIRST `IFCPROJECT` — for every entity regardless of which project it actually belonged to. An entity belonging to a LATER project with a DIFFERENT declared unit was scaled by the wrong factor: quietly wrong, not absent, and compliance-critical for IDS (a `Width >= 100mm` requirement evaluates against the wrongly-scaled value and can flip pass to fail, or the reverse, with no signal to the author).

`collectAllPropertySets` now resolves scales per entity via the new `resolveEntityMeasureScales` (`@ifc-lite/ids/bridge/units.ts`), which walks the entity's real spatial containment (`IfcRelContainedInSpatialStructure`/`IfcRelAggregates`, with an `IfcRelDefinesByType` hop for a type-level entity) up to its own owning `IfcProject` via the new `@ifc-lite/parser` export `resolveOwningIfcProjectId`, falling back to the store-wide default when the walk can't place the entity. An ordinary single-`IFCPROJECT` file (the overwhelming common case) takes an unchanged fast path with zero behaviour change.
