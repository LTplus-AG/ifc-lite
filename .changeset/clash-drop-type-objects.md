---
'@ifc-lite/clash': patch
'@ifc-lite/parser': minor
---

clash: drop IFC type objects from the clash and duplicate candidate set

An `IfcWallType`/`IfcSpaceType`/`IfcDoorStyle` carries the `RepresentationMaps`
template that its occurrences instantiate. The mesher turns that template into
geometry, which lands on top of the very occurrences that use it — so the type
read as a duplicate of its own occurrence, and clashed against elements it never
physically touches. On one public sample model this accounted for 114 of 282
reported clashes and for the model's only reported duplicate.

Type objects are now filtered out alongside the other non-physical types, which
also closes the gap the earlier `IfcSpace` exclusion left open: the space was
excluded by name while `IfcSpaceType` sailed straight through.

`isIfcTypeLikeEntity` is now exported from `@ifc-lite/parser` so the clash
adapter uses the same predicate the parser classifies entities with.
