---
"@ifc-lite/export": patch
---

`MergedExporter`: an IFC2X3 merge no longer writes a second `IfcRelDefinesByProperties` for a property set a later model repeats by GlobalId (#5774). IFC2X3 bounds `IfcPropertySetDefinition.PropertyDefinitionOf` to one relationship; the later model's rel is now dropped, and any object only it defined is added to the property set's one written rel instead. IFC4 and IFC4X3 are unchanged, since `DefinesOccurrence` is `SET [0:?]` there. The one-parent pass behind #5471/#5726 is now one table of single-valued inverses per output schema, checked against the EXPRESS schemas.
