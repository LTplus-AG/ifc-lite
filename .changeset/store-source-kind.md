---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/create": patch
"@ifc-lite/viewer": patch
---

A data store now says what backs it, separately from its schema. `IfcStoreBase.sourceKind` is `'step'` for a parsed STEP file and `'tabular'` for a store a reader built from finished tables (IFCX). `iterateEffectiveEntities` and `countEffectiveEntityTypes` walk the entity table of a `'tabular'` store, where they used to do so only for a store labelled `'IFC5'`; `EffectiveEntitySource` carries `sourceKind` in place of `schemaVersion`. The paths that need STEP records (STEP and ion export, the schedule splice, wall joins, hosted openings, stairs and railings, remeshing, the IDS worker, the alignment section) refuse a tabular store whatever its schema label. Loading and exporting STEP and IFCX files is unchanged.

`declareLengthUnitScale` takes the unit's source as an optional third argument, so a reader whose file declares its unit is no longer reported as defaulted.
