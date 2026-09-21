---
"@ifc-lite/wasm": patch
---

Port the structural-analysis IFC2X3 rename fixes to the Rust schema converter (`rust/export/src/schema_convert.rs`, used by the native/WASM export path): `IfcStructuralLoadCase`, `IfcStructuralCurveAction` and `IfcStructuralSurfaceAction` now map to `IfcStructuralLoadGroup`/`IfcStructuralLinearAction`/`IfcStructuralPlanarAction` instead of silently passing through under their IFC4-only type names.
