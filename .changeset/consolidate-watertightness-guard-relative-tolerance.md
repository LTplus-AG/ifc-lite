---
'@ifc-lite/geometry': patch
---

Fix the CSG consolidation watertightness guard being unable to see a hairline tear it exists to catch (issue #3353).

`consolidate_coplanar`'s WATERTIGHTNESS GUARD compares open-edge counts between the raw kernel output and the re-triangulated consolidated mesh, falling back to raw only when raw is cleaner. It measured both with a flat 1 mm vertex-merge grid. On a rotated-box union, the raw kernel output is watertight but consolidation introduces an open edge roughly 3-10 µm wide — far below the 1 mm grid, so the guard read the torn mesh as clean and never fell back, shipping the tear.

The grid is now relative to the mesh's own extent (`extent * 2^-21`, clamped to [1 µm, 1 mm]) instead of a flat constant. This keeps a constant ~4x margin over the f32 ULP spacing at that extent at any coordinate magnitude, so it stays fine enough to catch a micron-scale tear on ordinary building-component-scale hosts while never going finer than 1 µm (proven false-positive-free by the existing `curved_wall_opening_seam_is_watertight` regression) and never coarser than the original flat 1 mm mark (a host whose own extent already exceeds ~2 km gets exactly today's behaviour).

Gated by a new unit test pinning the #3353 repro directly against `consolidate_coplanar`, and by the full `ifc-lite-geometry` lib suite (728 tests, unchanged pass count). The end-to-end pinned regression in `rust/geometry/tests/issue_3353_boolean_tear.rs` (see PR #3388) now passes with `--ignored`.

The full `triangulation_invariance` census has NOT been re-run against this change (disk constraints in the session that produced it) and should be run before merge.
