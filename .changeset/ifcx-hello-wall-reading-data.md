---
"@ifc-lite/data": minor
---

`iterateEffectiveEntities` walks the entity table of an IFCX (`schemaVersion` `'IFC5'`) source that has no STEP type index, so spaces and every other class are enumerable there instead of the walk finding nothing; a filtered call reads classes from buckets built once per table. New type `DerivedEntities` describes the rows an IFCX reader derived (`retyped`, `added`) that the source file does not state, for exporters.
