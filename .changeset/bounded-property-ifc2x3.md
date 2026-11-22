---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Reject IFC2X3 conversion of an IfcPropertyBoundedValue when neither bound can be carried, and identify the affected record and WR22 rule in the error. Keep a supported bound if its counterpart is dropped (#11117).
