---
"@ifc-lite/export": patch
---

`MergedExporter` keeps an entity that several models share by GlobalId in one relationship per single-valued inverse (#5923). Before, the output could put one element in two storeys (`ContainedInStructure`), give an opening two voided elements, an element two fillings, an object two types, or a type two type relationships, among other things. The inverse table now also covers containment, `IfcRelVoidsElement`, `IfcRelFillsElement`, `IfcRelDefinesByType` (IFC2X3 `ObjectTypeOf` and `IfcObject.WR1`; IFC4 `IsTypedBy`/`Types`), `IfcRelDeclares`, `IfcRelDefinesByObject`, coverings, flow control, ports, services, structural activities, projections, IFC2X3 groups and task times, and IFC4X3 `IfcRelAdheresToElement`. Each row is checked against the EXPRESS schemas. A later model's objects on a type's relationship are folded into the first one, so no object loses its type.
