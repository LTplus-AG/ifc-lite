---
"@ifc-lite/geometry": patch
---

Wire the GPU-instancing worker→main shard channel (emit-both verification path).
The geometry worker also collates each batch into an IFNS shard via
`processGeometryBatchInstanced` (guarded — a no-op until the wasm exposes it) and
posts the bytes alongside the flat meshes; the parallel pool forwards them on the
streaming `batch` event as `instancedShards`. The viewer decodes + uploads them as
instanced overlays. Additive: the flat geometry path is unchanged, and the shard
channel is inert until the wasm rebuild emits shards.
