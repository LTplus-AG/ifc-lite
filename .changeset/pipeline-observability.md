---
"@ifc-lite/wasm": minor
---

Add `IfcAPI.getPipelineDiagnostics()`: a structured, versioned per-load diagnostics object (schemaVersion + summed geometry wall time, mesh/triangle counts, degenerate-backstop drops, and CSG failure aggregates) accumulated across every `processGeometryBatch*` call and reset on load boundaries. Complements the existing `diagnoseGeometry` channel; always on (cheap counters, JS clock so it is wasm-safe). Native geometry diagnostics also gain structured `tracing` coverage behind a default-off `observability` cargo feature; default builds are byte-unchanged.
