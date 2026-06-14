---
"@ifc-lite/geometry": patch
---

Speed up the exact CSG kernel's constraint-recovery hot path on dense-opening models (#1109).

Profiling the boolean-heavy slabs that hung the geometry stream showed the kernel spends ~80% of its time in constraint-recovery retriangulation — split between the channel-detection scan and the pocket earcut. Two parity-safe optimizations:

- **Channel detection.** The per-segment O(tris) channel scan recomputed `orient(a,b,vertex)` for each triangle *edge*, but a triangle has only three vertices — so compute each vertex's side of the `(a,b)` line once and run the reciprocal edge-side test only for edges whose endpoints straddle it: ~3 exact predicates per triangle instead of up to 12. **Channel scan 9.6s → 2.9s (3.3×)** on the profiling corpus.
- **Pocket earcut.** The ear-emptiness test ran an exact `strictly_outside` predicate for every other ring vertex. A conservative f64-AABB prefilter (the same widened-margin technique already used by `tri_aabb_disjoint`) skips the exact test for vertices provably outside the ear's AABB. This cuts the earcut's exact-predicate count on large pockets, which also lowers the per-element escalation count, so the #1109 budget cuts more openings exactly before degrading.

Both produce **byte-identical** output — they compute the same exact predicate signs, and the prefilter only skips vertices it proves are outside — so the pinned determinism manifests, snapshots, and native==wasm parity are unchanged. End-to-end on a boolean-heavy structural model (per-element budget on): 23.6s → 19.4s of serial geometry; the channel-detection raw speedup is 3.3× (the budget converts the remaining headroom into more openings cut exactly rather than pure wall-time).
