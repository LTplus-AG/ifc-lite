---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Both STEP exporters now leave IfcStructuralAnalysisModel.SharedPlacement unset on an IFC2X3 to IFC4 export when any IfcRelAssignsToGroup grouping items into that model lists a non-reference item, since the model's items are then not fully known (#10597).
