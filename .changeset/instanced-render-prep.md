---
"@ifc-lite/renderer": patch
---

Add GPU-instancing render prep (`prepareInstancedRender`, `composeInstanceMatrix`)
that turns a decoded IFNS shard into render-ready templates: each unique geometry
once plus a per-instance buffer (mat4 + entityId + rgba) for `drawIndexed(.., instanceCount)`.
The per-instance matrix folds the constant IFC Z-up→WebGL Y-up swap into
`SWAP·rel_k·T(origin)`, so instanced occurrences land in the exact same world
frame the flat path produces (`swap(rel_k·(origin+p)) == swap(origin_k+p_k)`),
verified GPU-free against an independent re-derivation. Additive and unused by the
default draw path until the instanced pipeline is wired.
