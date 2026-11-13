---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/create": patch
"@ifc-lite/viewer": patch
---

A data store now says what backs it, separately from its schema. `IfcStoreBase.sourceKind` is `'step'` for a parsed STEP file and `'tabular'` for a store a reader built from finished tables (IFCX). `iterateEffectiveEntities` and `countEffectiveEntityTypes` walk the entity table of a `'tabular'` store, where they used to do so only for a store labelled `'IFC5'`. `EffectiveEntitySource` gains `sourceKind` and keeps `schemaVersion` as a deprecated member it no longer reads, so a caller that still passes the label compiles unchanged: it just no longer selects the entity table. The paths that need STEP records (`export.ifc`, the changes export and its schedule splice, ion upload and its model list, wall joins, hosted openings, stairs and railings, trim/extend, carried joins, curtain walls, remeshing, the IDS worker, the alignment section, the analytic source decoder and registry publishing) refuse a tabular store whatever its schema label. Two sites of the same class still decide by the label alone and are left for a follow-up: the main Export dialog's STEP and merged branches (`ExportDialog.tsx`), and the collab share seed (`share-scope.ts`). Neither is reachable until a reader builds a tabular store under a non-IFC5 label. Loading and exporting STEP and IFCX files is unchanged.

`declareLengthUnitScale` takes the unit's source as an optional third argument, so a reader whose file declares its unit is no longer reported as defaulted.
