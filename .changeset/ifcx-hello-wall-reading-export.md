---
"@ifc-lite/export": patch
---

The IFC5 exporter writes the classes the source IFCX file states: a window type the reader derived keeps the file's `IfcWindow`, and the `IfcMaterial` rows the reader added from class-less nodes are not written.
