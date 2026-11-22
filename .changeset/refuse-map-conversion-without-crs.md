---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Reject unplanned STEP georeferencing edits that request an IfcMapConversion without an existing or requested IfcProjectedCRS. Both STEP writers return a missing TargetCRS error so the viewer can report the failed export (#11259).
