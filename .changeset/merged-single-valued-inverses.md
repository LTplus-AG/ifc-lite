---
"@ifc-lite/export": patch
---

`MergedExporter` no longer writes a second relationship into a single-valued inverse when a later model repeats an entity by GlobalId (#5923, #5774). The one-parent rule that already covered `IfcRelAggregates` and `IfcRelNests` now covers every such inverse of the output schema: `IfcRelContainedInSpatialStructure` (`ContainedInStructure`), `IfcRelDefinesByType` (`IsTypedBy`/`Types`, IFC2X3 `ObjectTypeOf` and `IfcObject.WR1`), `IfcRelDefinesByProperties` (`DefinesOccurrence`, IFC2X3 `PropertyDefinitionOf`), `IfcRelDefinesByTemplate`, `IfcRelDeclares` (`HasContext`), `IfcRelVoidsElement` and `IfcRelFillsElement`. For a property set or type that a later model also relates to new elements, those elements are added to the first model's relationship instead, so no element loses the definition.
