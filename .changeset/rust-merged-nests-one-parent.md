---
"@ifc-lite/wasm": patch
---

The native (Rust) merged exporter now matches the TypeScript `MergedExporter` on decomposition parents (#5802, the Rust twin of #5726 and #5725). `IfcRelNests` now counts against the one-parent rule, per output schema: in IFC2X3 a nest and an aggregation share `Decomposes : SET [0:1]`, so a unified part that is already aggregated no longer gets a nesting parent too. In IFC4 and later `Nests` is its own `SET [0:1]`, so a second nesting parent is refused. `drop_empty_containers` now also drops a container that the one-parent pass empties, for example a later model's Site whose only child is a Building that unified with one already parented.
