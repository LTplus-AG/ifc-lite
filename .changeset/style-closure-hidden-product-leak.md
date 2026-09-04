---
'@ifc-lite/export': patch
---

A `visibleOnly` STEP export could ship a hidden product's geometry through a shared `IfcPresentationLayerAssignment` (or `IfcStyledItem`/`IfcStyledRepresentation`). These entities reference geometry the closure walk cannot reach on its own, so the export rescues one whenever it names an already-visible item — but the rescue then walked ALL of that entity's references unconditionally, with no check for whether the other item(s) it named belonged to a hidden product. One CAD layer naming every wall's shape representation is a routine real-world shape, so hiding one wall that shared a layer with a visible wall pulled the hidden wall's own geometry back into the export. The forward walk now refuses to add a representation/geometry id that was not already independently visible, and the rescued entity's own output line is narrowed (or withheld) the same way a relationship's is, so it no longer ships a dangling reference to the geometry it can no longer name.

The `subsetEntityIds` path (what the anonymize export drives) is pinned by its own real-fixture test, including the case where the rescued entity's line cannot be narrowed at all and is withheld: the export now names it in `stats.warnings` instead of letting it disappear silently.
