---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

For unedited, full-model IFC2X3 to IFC4 exports, the Rust STEP exporter now writes IfcStructuralAnalysisModel.SharedPlacement as the TypeScript one does: when the structural items a model groups sit on one local placement or equal copies of it, the lowest-id copy becomes SharedPlacement and the items are placed by it (#10597).

Both exporters now leave SharedPlacement unset for a model whose IfcRelAssignsToGroup lists a non-reference item.
