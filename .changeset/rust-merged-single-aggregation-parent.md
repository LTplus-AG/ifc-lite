---
"@ifc-lite/wasm": patch
---

The native (Rust) merged exporter now keeps one `IfcRelAggregates` parent per object, matching the TypeScript `MergedExporter` (#5727, the twin of #5471). Before, it dropped a later model's aggregation only when both its parent and every member had unified into the first model. An aggregation that named a unified container and also a new object was kept whole, which gave the container a second parent and failed `IfcSpatialStructureElement.WR41`. Now any member that already has a parent in the output is removed, and the rest of the aggregation is kept. The rule runs on the final written line, after spatial and GlobalId unification, and carries across every later model. It replaces the old all-members rule.
