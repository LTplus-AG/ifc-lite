---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Both STEP exporters now leave IfcStructuralAnalysisModel.SharedPlacement unset on an IFC2X3 to IFC4 export when any IfcRelAssignsToGroup grouping items into that model lists a non-reference item, since the model's items are then not fully known. The readable items of such a grouping still count as grouped by that model, so another model grouping one of them gets no SharedPlacement either (#10597).

The TypeScript loss report for IFC4 to IFC2X3 follows the same rule: it no longer lists SharedPlacement as restored for such a model.
