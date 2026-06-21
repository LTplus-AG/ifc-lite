---
"@ifc-lite/cache": patch
---

Persist GPU-instancing shards in the binary cache (new `InstancedShards` section,
`GeometryData.instancedShards` / `CacheReadResult.geometry.instancedShards`). Opaque
repeated occurrences are partitioned off the flat geometry into IFNS shards rendered
from compact templates; without persisting them, reopening a cached model restored
the flat meshes only and silently dropped all instanced geometry. The shard bytes
are a self-contained wire format, so they're stored as a length-prefixed blob array
(no re-encode) and restored through the renderer's normal decode/upload path.
`FORMAT_VERSION` is bumped 9 → 10 so stale shard-less caches invalidate and re-mesh.
