---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

A cache hit now inflates and decodes its geometry chunks on the cache workers, and starts them when the entry's header is read, so they decode while the main thread decodes the metadata. Each chunk's meshes come back in one message whose arrays are transferred, not copied; appearance sources shared through the section pool keep their identity. `ChunkInflatePool.decode` and the `decode` option of `openGeometryChunksV13` (type `ChunkDecode`) are new. A worker failure decodes on the calling thread exactly as before, and a chunk that does not decode anywhere is a `CorruptChunkError`.
