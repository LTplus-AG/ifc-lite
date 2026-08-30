---
'@ifc-lite/parser': patch
---

Fix the legacy `RelationshipExtractor.extractRelationships()` silently dropping every `IfcRelAssociatesMaterial` relationship.

Its "standard" attribute-slot branch assumed `RelatingObject` sits at attribute index 4 and `RelatedObjects` at index 5 — true for `IfcRelAggregates`, but backwards for `IfcRelAssociatesMaterial`: `RelatedObjects` (a list) is inherited from `IfcRelAssociates` at index 4, and `RelatingMaterial` (a single reference) is `IfcRelAssociatesMaterial`'s own attribute at index 5. Reading them swapped meant the list failed the "is this a number" check and the single reference failed the "is this an array" check, so `extractRelationship()` always returned `null` for this type — every material association vanished from the legacy `parse()` path's `relationships` array with no warning.

`IfcRelAssociatesMaterial` now gets its own branch (`RelatedObjects` at 4, `RelatingMaterial` at 5), matching IFC4's `IfcRelAssociates`/`IfcRelAssociatesMaterial` schema.
