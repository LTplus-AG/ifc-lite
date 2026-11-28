---
"@ifc-lite/export": major
---

A full IFC2X3 to IFC4 export now writes an incomplete varying structural action as an IfcStructuralCurveAction or IfcStructuralSurfaceAction with PredefinedType CONST, as the subset export does. It keeps a usable initial load, links the retained reaction through an IfcRelAssignsToProduct named Causes, and reports the omitted varying locations and subsequent loads.

**Breaking change.** When the constant fallback has no usable initial AppliedLoad, TypeScript `StepExporter.export` throws and the Rust single-model STEP writers return an error identifying the action. Previously a full export returned STEP output for this input. Merged-writer conversion is tracked separately in #11698.
