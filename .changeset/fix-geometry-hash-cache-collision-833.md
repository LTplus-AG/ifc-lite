---
"@ifc-lite/wasm": patch
---

`GeometryRouter::get_or_cache_by_hash` now performs a full equality
check on every hash hit before reusing the cached `Arc<Mesh>` (issue
#833). The previous fast path returned a hash match without checking
geometry, on the theory that `FxHasher`'s 64-bit output collides only
~1 in 2^64. Under wasm32 codegen on `schependomlaan.ifc`, two slabs
with mirrored rectangular cross-sections (a 7.43 m × 3 m profile in
+X+Y vs −X−Y) hashed to the same value: the second slab's local mesh
was silently replaced by the first, and after placement the slab
rendered as a "floating" mesh 7.43 m off the building. Native x86_64
hashes both meshes distinctly, which is why the bug only surfaced in
the browser — the regression was invisible to the Rust integration
tests until we forced a collision in the new
`router::caching::tests::collision_does_not_silently_swap_meshes`
test.

On a true match (the cache's intended fast path — repeated geometry
across N storeys, instanced doors / windows) we still return the
shared `Arc`, so dedup behaviour is preserved. On a false-positive
hash hit we return a fresh `Arc` without overwriting the existing
entry, so subsequent identical lookups continue to dedupe.
