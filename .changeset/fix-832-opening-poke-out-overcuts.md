---
"@ifc-lite/wasm": patch
---

Fix `IfcOpeningElement` punching through the entire wall when the
authored opening pokes past one wall face (issue #832).

`router/voids.rs::extend_opening_along_direction` is a Revit/ArchiCAD
heuristic that stretches an opening AABB along its own extrusion axis
to make sure the AABB clip lands cleanly on both wall faces. It was
designed for the "opening modelled too short" pattern — opening fully
inside the wall in extrusion direction. When an opening is *offset*
so part of it sticks out one face (e.g. a 1 m × 1 m × 0.2 m opening
positioned so its 0.2 m depth straddles the wall's +X face at exactly
the wall-thickness boundary), the heuristic over-extended through
the wall and the AABB clip removed BOTH the touched and untouched
wall faces — the "punched-through slot" the bug reporter saw on
wall #222 in `ifc-opening.ifc`.

The fix adds a gate that bails out of the extension when the
opening's projection on its own extrusion axis pokes past either
wall projection — comparing projections (not raw coords) so the
sign of the extrusion direction is irrelevant. The author's bite
is preserved verbatim and the AABB clip only removes the wall
material the opening actually intersects.

Regression coverage:

- `rust/geometry/tests/issue_832_opening_representations.rs` — full
  pipeline test against the reporter's 5-wall fixture, asserting
  each wall ends up with a bounded hole and the wall faces the
  opening doesn't reach remain pristine 2-triangle rectangles.
- `router::voids::reveal_tests::test_extend_opening_skipped_when_opening_pokes_past_wall`
  — direct unit test pinning the new gate, covering both `+X` and
  `-X` extrusion-direction polarity.
- The existing #604 "exact-match coplanarity pad" regression
  (`test_extend_opening_pads_past_wall_on_exact_match`) still passes
  unchanged — the new gate intentionally does not fire when the
  opening fits exactly inside the wall.

Fixture `tests/models/issues/832_opening_representations.ifc` (11 KB,
SHA-256 `0a81eda40a3b…`) added to the manifest. The bytes need to be
uploaded to the `fixtures-v1` GitHub Release via `pnpm fixtures:upload`
once merged.
