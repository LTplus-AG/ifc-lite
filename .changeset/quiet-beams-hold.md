---
"@ifc-lite/export": patch
---

A full IFC2X3 to IFC4 export now writes an incomplete varying structural action as an IfcStructuralCurveAction or IfcStructuralSurfaceAction with PredefinedType CONST, as the subset export does. It keeps a usable initial load, links the retained reaction through an IfcRelAssignsToProduct named Causes, and reports the omitted varying locations and subsequent loads. If the action has no usable initial load, the export reports the affected record and fails. Before, it kept the IFC2X3 keyword, which IFC4 does not declare. This covers `StepExporter` and the Rust single-model writers; `MergedExporter` still keeps the keyword.
