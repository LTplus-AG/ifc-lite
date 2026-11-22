---
"@ifc-lite/export": major
"@ifc-lite/wasm": major
---

Reject unplanned STEP georeferencing edits that request an IfcMapConversion without an existing or requested IfcProjectedCRS. Both STEP writers return a missing TargetCRS error so the viewer can report the failed export (#11259).

Callers that previously handled this diagnostic as a warning must now handle the export error.
