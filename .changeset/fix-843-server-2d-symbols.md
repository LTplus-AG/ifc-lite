---
"@ifc-lite/wasm": patch
---

Expose 2D symbol data (`IfcGrid` axes and `IfcAnnotation` polylines) in
the server's `ParseResponse` so callers don't have to re-parse the IFC
on the client to get the same primitives the browser-side
`parseSymbolicRepresentations` API already exposes (issue #843).

Add a new `ifc_lite_processing::extract_symbolic_data` function and a
`SymbolicData` field on `ParseResponse`. The extractor walks the file
once and emits:

- One `SymbolicGridAxis` per `IfcGridAxis` in any `IfcGrid.UAxes` /
  `VAxes` / `WAxes` list, with the axis tag and endpoint pair in
  metres.
- One `SymbolicPolyline` per `IfcPolyline` item inside an
  `IfcAnnotation`'s `Annotation` / `FootPrint` / `Plan` / `Axis`
  shape representation.

The HTTP route (`POST /api/v1/parse`) calls the extractor in the same
`spawn_blocking` as the geometry pipeline and serialises the result
under `symbolic_data` (omitted from JSON when empty).

This is a scaffolding step toward full parity with the wasm-side
symbolic extractor (`rust/wasm-bindings/src/api/symbolic.rs`, ~2100
lines) — trimmed-curve arcs, fill areas, text literals, and per-axis
styling still live wasm-side and need a deeper refactor into this
crate. The field names mirror the wasm collection's so future work
can extend `SymbolicData` without breaking the response shape.

Regression coverage:

- `rust/processing/tests/issue_843_symbolic_data.rs` — three tests
  covering grid-axis extraction (tags, endpoints, grid grouping),
  annotation polylines (closed-loop detection, representation tag),
  and the empty-IFC happy path. Uses an inlined synthetic IFC4 file
  so the tests don't depend on an external fixture.
