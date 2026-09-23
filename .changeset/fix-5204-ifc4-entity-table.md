---
"@ifc-lite/export": patch
---

Fix schema conversion silently passing 20 IFC4X3-only entity types (the alignment domain: `IfcLinearPlacement`, `IfcOffsetCurve`, `IfcTriangulatedIrregularNetwork`, and others) through IFC4X3→IFC4 conversion unconverted, and dropping `IfcCartesianPointList2D`/`3D`'s IFC4X3-only `TagList` attribute. The converter's attribute-name table now comes from the EXPRESS-derived schema registry instead of the vendored buildingSMART C# table, which misfiles those entities into its IFC4 section.
