---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Preserve MEP occurrence identity, placement, geometry and relationship endpoints when downgrading IFC4 or IFC4X3 to native IFC2X3 base types, including IfcDuctSegment to IfcFlowSegment. Retain existing duct type assignments and reconcile target attributes by schema name.
