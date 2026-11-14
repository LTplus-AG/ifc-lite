---
"@ifc-lite/data": minor
"@ifc-lite/viewer": patch
---

Physical-object counts no longer read 0 for a model whose rows are a table rather than STEP records (#10018). An IFCX model (and a Rhino `.3dm` import, which builds the same kind of store) showed "Elements with Geometry: 0" in the model metadata panel, and 0 objects in the status bar and viewport summary, because `collectEffectivePhysicalEntityIds` collected the classes to enumerate from `entityIndex.byType`, which such a store leaves empty.

`@ifc-lite/data` now exports `sourceEntityClasses(source)`: the classes a source's own rows carry, read from the STEP type index or, for a tabular source, from the entity table's buckets. It is the class-list counterpart to `iterateEffectiveEntities`, keyed on the same `sourceKind` marker, so the two agree about what a source holds. The buckets are the ones a filtered `iterateEffectiveEntities` call reads, so narrowing a walk this way does not walk the table twice. STEP sources yield exactly the type-index keys they did before.
