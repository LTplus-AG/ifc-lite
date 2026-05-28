---
"@ifc-lite/wasm": patch
---

Render `IfcAlignment` directrix curves and confirm `IfcGeographicElement`
terrain meshes load (issue #844).

`IfcGeographicElement` already routes through the standard pipeline —
its `'Body','Tessellation'` representation hits the existing
`TriangulatedFaceSetProcessor`. The issue was only ever the
`IfcAlignment` side: in IFC4X1 the alignment carries its curve in a
dedicated `Axis` (`IfcAlignmentCurve`) attribute and the file's
`Representation` is typically `$`, so `process_element` bailed before
reaching any geometry.

Add `IfcAlignmentProcessor` that consumes the Axis curve via the
existing `AlignmentCurve` evaluator (full IFC4X1 horizontal + vertical
parser already used by `SectionedSolidHorizontalProcessor`) and
samples it at 1 m intervals into a thin triangulated ribbon centred on
the directrix. Short-circuit `process_element` for `IfcAlignment` so
the missing-representation path falls through to the ribbon processor.

Regression coverage:

- `rust/geometry/tests/issue_844_terrain_and_alignment.rs` — drives the
  reporter's IFC4X1 fixture. Verifies both `IfcGeographicElement` #30
  (Terrain) tessellates and `IfcAlignment` #59 (the 'A1' alignment,
  8 horizontal + 24 vertical segments) renders as a ribbon spanning
  more than 2 m on its longest axis.

Fixture `tests/models/issues/844_terrain_and_alignment.ifc` (530 KB)
added to the manifest.
