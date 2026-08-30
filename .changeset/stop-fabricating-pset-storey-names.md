---
'@ifc-lite/parser': patch
---

Stop fabricating display placeholders (`Entity #<id>`, `PropertySet #<id>`, `QuantitySet #<id>`, `'Material Properties'`) for a spatial node, property set, quantity set, or material property set the source declared no Name for.

`SpatialHierarchyBuilder`'s `SpatialNode.name`, `store.getProperties()`, `store.getQuantities()`, and the material-properties reader now leave the name empty (`''`) instead. Those placeholders were indistinguishable downstream from a genuinely-declared Name: `Ifc5Exporter` writes an unnamed spatial node's fabricated `Entity #<id>` out as a genuinely-declared `bsi::ifc::prop::Name` on IFCX export (round-tripping back in as real on read), and `EntityNode.properties()`/`quantities()` — the surface MCP tools and the SDK's `bim.properties()`/`bim.quantities()` return verbatim — did the same for the pset/qset placeholders. A UI layer that wants a display label for an unnamed node/set now derives one at render time instead of receiving a value indistinguishable from a real one.
