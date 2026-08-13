---
'@ifc-lite/wasm': minor
---

Add `clashIntersectionSolid` — the overlap VOLUME of a clashing pair, as a solid.

Clash presentation today marks the contact *point*. A point cannot show how deep an overlap is, what shape it has, or which direction it runs. BIMcollab Zoom and Solibri instead draw the intersection volume as an opaque solid inside two ghosted parents, which reads at a glance. This is the engine half of that: given the world-space triangles of two clashing elements, return the mesh of their actual overlap.

It runs on the existing pure-Rust exact CSG kernel — the same arrangement that cuts opening voids — through `BoolOp::Intersection`, which the kernel already implements. No new geometry code, and no need for the `A − (A − B)` derivation: intersection is a first-class kernel op. A new `ifc_lite_geometry::intersection_solid` wraps it; the wasm export is a thin binding over that.

On demand, one pair per call. Nothing in the detection sweep touches it, so scan cost is unchanged. Measured on a road/bridge certification model (88 hard clashes, 48 elements), one `intersection_solid` call costs a median of 0.59 ms and a max of 38.6 ms release-build; the max is a 264-triangle railing against a beam, and every pair not involving those railings is under 10 ms. Computing all 88 eagerly would have cost 216 ms.

Results carry f64 positions rather than the f32 the mesh pipeline uses elsewhere, because the caller reports a volume: on the analytic rotated-box oracle the f64 path returns exactly 9.375 m³ where the f32 round-trip returns 9.374999882.

**The result is gated, and often absent.** The kernel snaps input coordinates to a `2^-16 m ≈ 15.26 µm` grid and treats faces inside `near_band_from_extent` as coplanar. Inside that band a thin overlap is resolved as a contact, not a solid, and the returned volume is *exactly 2/3* of the truth — measured at world offsets 0, 10, 100 and 1000 m, at every tessellation. A −33 % solid is worse than no solid, because it looks plausible. So `intersection_solid` returns a solid only above 4× that band, where the volume is exact to f64, and otherwise reports why: `no-overlap`, `below-kernel-resolution` (with the measured thickness and the depth that would have been needed), `empty-operand` or `budget-exhausted`. Callers should keep the existing contact marker whenever `isSolid` is false.

How often that happens is the honest headline: on the bridge model **30 of 88 clashes yield a solid, 54 return `no-overlap` and 4 `below-kernel-resolution`**. The 54 are real findings whose interpenetration is below the snap grid — sub-micron grazes of 0.3–1.5 µm are the genuine coordination issues on that model, four orders of magnitude under one grid cell. For those, no intersection solid exists at this kernel's resolution and the viewer will fall back to the contact marker. The feature helps most where clashes are deep; the largest solid found was 0.0727 m³ between two crossing beams.

Verified against an analytic oracle before any wiring: axis-aligned and rotated boxes with hand-derived expected volumes, asserted at 12, 48 and 192 triangles per operand (and at every mixed pair of those) so a tessellation-sampling artifact cannot pass — the failure mode a previous clash depth metric shipped with. Degenerate inputs are covered: coplanar touching faces, sub-micron grazes, disjoint pairs and empty operands all return a reason rather than a sliver or a crash.
