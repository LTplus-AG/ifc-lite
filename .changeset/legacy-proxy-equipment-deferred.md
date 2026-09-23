---
"@ifc-lite/wasm": patch
---

Keep IFC2X3 `IfcProxy` and `IfcEquipmentElement` entities in the deferred geometry batch. Retiring the legacy type table had silently moved both into the eager first-frame batch, unlike the `IfcBuildingElementProxy` and `IfcDistributionElement` types they used to be classified as.
