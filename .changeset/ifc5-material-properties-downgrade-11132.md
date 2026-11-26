---
"@ifc-lite/export": patch
---

Omit IfcMaterialProperties when downgrading IFC5 to IFC2X3 and report the affected record IDs. The exporter has no IFC5 attribute registry to safely reorder the record.
