---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

For unedited, full-model exports, the Rust STEP exporter now carries IfcStructuralAction.CausedBy between IFC2X3 and IFC4 as the TypeScript one does: the upgrade writes an IfcRelAssignsToProduct named 'Causes', and the downgrade fills CausedBy from one such relationship naming one point reaction (#10597).

Both exporters now reject a Causes relationship as evidence for CausedBy when RelatedObjects contains a non-reference item.
