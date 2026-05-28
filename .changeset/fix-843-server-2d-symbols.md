---
"@ifc-lite/wasm": minor
---

Expose full 2D symbol data in the server's `ParseResponse` at parity
with the browser-side parser (issue #843). The server now ships the
same primitives the browser does: `IfcGrid` axis lines + bubble + tag
glyphs, `IfcAnnotation` polylines, `IfcIndexedPolyCurve`,
`IfcCircle` disks, `IfcEllipse` tessellations, `IfcTrimmedCurve` arcs
with `PLANEANGLEUNIT` scaling + sense-agreement + wrap-around,
`IfcCompositeCurve` recursion, `IfcGeometricSet` /
`IfcGeometricCurveSet` recursion, `IfcMappedItem` with `MappingOrigin`
+ `MappingTarget` transform composition, `IfcTextLiteral` /
`IfcTextLiteralWithExtent` with placement composition / `BoxAlignment`
/ cap-height derived from extent box, `IfcAnnotationFillArea` with
outer ring + optional hole rings, and `IfcStyledItem` colour
resolution (`IfcTextStyle` → `IfcColourRgb`, `IfcFillAreaStyle` →
`IfcColourRgb`).

The full 2 100-line extractor that used to live in
`rust/wasm-bindings/src/api/symbolic.rs` has been moved into
`ifc_lite_processing::symbolic` as the canonical implementation.
Both pipelines now call the same function:

- HTTP server: `extract_symbolic_data(&content) -> SymbolicData`
  serialised under `symbolic_data` in `ParseResponse`.
- WASM bindings: `IfcAPI.parseSymbolicRepresentations(content)` is now
  a thin wrapper that calls `extract_symbolic_data` and converts the
  result into the existing `SymbolicRepresentationCollection`
  `wasm_bindgen` type via a new `from_data()` constructor.

Net effect: zero behaviour change for the JS side (the
`SymbolicRepresentationCollection` API surface is unchanged) but the
server response now carries every primitive the renderer can paint,
not just the scaffolding subset that the first cut had been
deliberately scoped to.

Coordinate handling at parity:

- Per-product `ObjectPlacement` resolution via `IfcLocalPlacement`
  chain (translations accumulate after rotation by parent, rotations
  accumulate to orient symbols).
- Per-representation `ContextOfItems.WorldCoordinateSystem` is
  composed in when present and non-trivial.
- Auto-detected RTC offset is subtracted (same threshold the mesh
  pipeline uses).
- Y-axis flip (`y → -y`) to match the renderer's section-cut coord
  convention.

P1 review feedback from chatgpt-codex on the original commit
(`symbolic.rs:181` — "Apply placements before emitting symbolic
coordinates") was already addressed by an earlier commit on this
branch (`ac72f039`) and remains addressed here: placements flow
through `resolve_object_placement` for every entity.

Regression coverage:

- `rust/processing/tests/issue_843_symbolic_data.rs` — original
  three tests updated for the new behaviour. Grid extraction also
  emits axis lines + bubble texts now; the annotation-only count is
  filtered by `representation = "Annotation"`.
- `rust/processing/tests/issue_843_symbolic_parity.rs` — four new
  tests driving a richer synthetic IFC4 file that exercises every
  new primitive family: `IfcCircle` disk, `IfcTextLiteralWithExtent`
  text, `IfcAnnotationFillArea` fill, `IfcEllipse` tessellation.
- Full `cargo test -p ifc-lite-geometry --tests`: 267 passed,
  0 regressions.
