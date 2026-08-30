---
'@ifc-lite/parser': patch
---

Stop fabricating display placeholders (`Entity #<id>`, `PropertySet #<id>`, `QuantitySet #<id>`) for a spatial node, property set or quantity set the source declared no Name for.

`SpatialHierarchyBuilder`'s `SpatialNode.name`, `store.getProperties()` and `store.getQuantities()` now leave the name empty (`''`) instead. Those placeholders were indistinguishable downstream from a genuinely-declared Name: `Ifc5Exporter` wrote an unnamed spatial node's fabricated `Entity #<id>` out as a genuinely-declared `bsi::ifc::prop::Name` on IFCX export (round-tripping back in as real on read), and `EntityNode.properties()`/`quantities()` — the surface MCP tools and the SDK's `bim.properties()`/`bim.quantities()` return verbatim — did the same for the pset/qset placeholders. A UI layer that wants a display label for an unnamed node/set now derives one at render time instead of receiving a value indistinguishable from a real one.

Two places that composed sets from more than one source keyed on that name, and an empty name made unrelated sets compare equal there. Both now treat an absent name as evidence of nothing: `extractTypePropertiesOnDemand`, `extractTypeEntityOwnProperties` and `extractTypeQuantitiesOnDemand` dedupe a type's `HasPropertySets` list against its `IfcRelDefinesByProperties` sets by express id rather than by name, so a second unnamed set on a type is no longer dropped; and `mergeInheritedPropertySets` no longer folds an unnamed inherited set into an unrelated unnamed occurrence set.
