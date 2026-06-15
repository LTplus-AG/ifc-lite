---
"@ifc-lite/geometry": patch
---

Speed up the exact CSG kernel ~42% on boolean-heavy models (Tekla 170_KM: 22.0s → 12.8s of serial geometry), byte-identical — the sign / boolean / retriangulation determinism manifests and full geometry suite are unchanged. Four profile- and literature-driven optimizations (Attene "Indirect Predicates" §5.4, Shewchuk):

- **BVH boolean classification** — `boolean_vids` scanned the *entire* opposite operand per arrangement triangle (an exact ray-cast + an exact coincident-face probe). A median-split AABB BVH (conservative ray + band-radius point queries) prunes each to O(log N + hits); the parity/any-match results are order-independent, so the verdict is unchanged.
- **Memoize `to_f64_pt`** — classification and the output map materialize the same heavily-shared conforming vertices many times; each interned point's f64 value is now computed once per arrangement.
- **Cache interval lambdas in the seg×seg pre-pass** — the O(n²) crossing loop re-derived each endpoint's degree-4/7 LPI/TPI interval lambda on every `orient2d`; compute it once and run the crossing test straight from it, falling to the exact cascade only on a straddle.
- **Materialize f64 from the cached lambda** — reuse the interner's already-cached I512 lambda instead of re-deriving it at I1024.

The remaining cost is the conforming retriangulation (constrained Delaunay) and the exact predicate arithmetic itself — the genuine exact-CSG floor. The win grows with operand size and applies to every boolean-heavy model.
