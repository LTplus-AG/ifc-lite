---
'@ifc-lite/geometry': patch
---

Close small boundary gaps the exact CSG kernel leaves on overlapping and rotated operand pairs.

Issue #3353: after the #3341 parity-segment fix closed the disjoint/touching tear family, a separate family survived on overlapping and rotated operand pairs. Reproduced with a sweep of rotated-cutter / axis-aligned-host box pairs across Difference, Union and Intersection, watertightness checked by welding the output at 0.1 mm and counting directed half-edges that fail to pair one-forward/one-reverse (a net-signed tally can cancel a real non-manifold seam to zero).

On one pinned case the raw kernel output is already watertight and `consolidate_coplanar`'s per-bucket independent re-triangulation is what tears it: the same boundary vertex comes out of two adjacent buckets a few hundred micrometres apart, because the bucket's own boundary within an axis-aligned plane is skewed by a rotated cutter. On another the raw arrangement output is already torn before consolidation ever runs. In both, the open edges' endpoints sit within a fraction of a millimetre of a vertex that should have been the same point.

`close_micro_gaps` (`rust/geometry/src/csg/consolidate.rs`) is a bounded, last-resort weld applied to whatever `consolidate_coplanar` is about to return: it runs only when that mesh already has an open boundary edge at 0.1 mm, so a sound mesh is returned untouched. When it runs, it welds vertices within a small multiple of the exact kernel's own snap grid (comfortably above the measured gaps, comfortably below any real feature) and keeps the weld only if it strictly reduces the open-edge count without increasing spike-triangle count. This is a repair, not a gate: unlike the closed-in/closed-out enforcement already tried and rejected for `ClippingProcessor::validate_mesh` (measured to regress the corpus watertightness census), a weld that does not help is simply discarded and the mesh returned exactly as it was — no cut is ever thrown away.

This does not close the whole family #3353 reports. The randomized sweep used to find it still measures a residual, smaller tear rate afterward; at least one case has open edges tens of millimetres apart that a vertex weld cannot fix, pointing at a deeper near-degenerate arrangement defect the issue's own investigation had already flagged as unproven. Two concrete cases the fix does close completely are pinned in `rust/geometry/tests/issue_3353_rotated_overlap_tearing.rs`.
