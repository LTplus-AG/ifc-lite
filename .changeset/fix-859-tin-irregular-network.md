---
"@ifc-lite/wasm": patch
---

Render `IfcTriangulatedIrregularNetwork` (terrain TIN) representations
(issue #859 follow-up to PR #866).

PR #866 stopped `IfcSolidStratum` (and the other concrete
`IfcGeotechnicalStratum` leaves) from being silently dropped at
`has_geometry_by_name`. That uncovered a second silent failure: the
stratum's body is typically an `IfcTriangulatedIrregularNetwork`, and
the geometry router rejected it with
`"Unsupported representation type: IfcTriangulatedIrregularNetwork"`
because no processor was registered for the type — the user's
`UT_Tin_in_MGA_56.ifc` reached the viewer with 0 meshes and an empty
viewport.

`IfcTriangulatedIrregularNetwork` is a subtype of
`IfcTriangulatedFaceSet`. It adds an optional `ClosedOrOpen` list at
the tail but inherits Coordinates / Closed / CoordIndex in the same
attribute slots — so the existing `TriangulatedFaceSetProcessor` is
correct for TIN as-is. The fix:

- Adds `IfcTriangulatedIrregularNetwork` to
  `TriangulatedFaceSetProcessor::supported_types()` so the router
  registers it against the same processor.
- Extends the `IfcTriangulatedFaceSet | IfcPolygonalFaceSet` match
  arms in `router/processing.rs` (RTC detection / large-coord checks)
  and `router/layers.rs` (no-position geometry list) to also include
  TIN.
- Adds TIN to `core::fast_parse::should_use_fast_path` so the
  direct-byte CoordIndex parser is used on real terrain meshes.

Regression coverage:

- `rust/geometry/tests/issue_859_tin_irregular_network.rs` — builds a
  minimal in-memory IFC4x3 file with an `IfcGeographicElement` whose
  body is a 2-triangle TIN, asserts the router produces a mesh with
  the authored bbox and triangle count. Pre-fix the call errored at
  the dispatch layer.
