---
"@ifc-lite/geometry": patch
"@ifc-lite/cache": patch
---

Cap the number of void cutters packed into a single CSG arrangement, fixing a
geometry-stream stall on models with elements that carry many openings.

`subtract_mesh_many` previously subtracted every disjoint cutter of a host in ONE
N-ary conforming arrangement. That arrangement's cost is super-linear in the
cutters packed into it, so an element with ~90 openings cost ~12 s in a single
arrangement (vs ~0.4 s chunked, 30x). On WASM that single element alone exceeded
the 40 s geometry-stream watchdog: an 86 MB model that loaded in ~15 s natively
stalled and failed to load in the browser. Because the per-element escalation
budget bounds escalations, not the base arrangement size, it did not catch this.

Void cutters here are order-free (set difference: `host − {all} ≡ host − {chunk₁}
− {chunk₂} − …`), so the cutters are now processed in chunks of 16, bounding the
per-arrangement cost so no single element can stall the stream. It is
solid-equivalent (the batch path's contract is volume parity + watertightness,
not byte-identical tessellation; the existing `subtract_many_*_matches_sequential`
equivalence tests and a new 20-cutter chunked-equivalence test all pass, and the
full geometry suite is unchanged). For hosts with <= 16 cutters this is exactly
the prior single arrangement. Verified end to end: the previously-stalling model
now loads completely and renders correctly.

Bumps the geometry cache `FORMAT_VERSION` (10 → 11). For a host with > 16 void
cutters the chunked cut is solid-equivalent but not byte-identical (and on
pre-fix builds those hosts often fell back to an AABB box), so the mesh hash
changes. The bump invalidates pre-fix caches so restored models re-mesh with the
correct tessellation, and the compare/diff feature does not flag those hosts from
a stale-cache hash mismatch.
