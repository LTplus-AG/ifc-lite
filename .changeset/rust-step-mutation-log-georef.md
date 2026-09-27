---
"@ifc-lite/wasm": minor
---

The Rust mutation-log STEP writer behind `exportStep` now applies a log's `georefMutations` (editing an existing `IfcProjectedCRS` / `IfcMapConversion` in place or creating them, `MapUnit` resolved to a project length unit or a new one, refused for an IFC2X3 output exactly as `StepExporter` refuses), completing the mutation vocabulary with byte parity to the TypeScript exporter (#5941). Native hosts get `export_merged_models_with_logs`, which bakes each edited model before merging as `MergedExporter.exportAsync` does.
