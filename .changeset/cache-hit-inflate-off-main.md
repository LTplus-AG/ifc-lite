---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

A cache hit inflates its compressed geometry chunks on a few workers instead of the main thread. `ChunkInflatePool` (new subpath `@ifc-lite/cache/chunk-inflate-pool`, so a viewer can load it lazily) runs the same `inflateRaw` in the cache's compression worker (new `inflate` request). If a worker fails, stops answering for `stallMs`, or sends a bad reply, the remaining chunks inflate on the calling thread. If a chunk's data does not inflate, the pool rejects it and every remaining chunk with `CorruptChunkError` instead of retrying here. `openGeometryChunksV13` and `decodeGeometryChunk` accept the inflate function to use, and `inflateRaw` is exported. The viewer starts the workers only for an entry with compressed chunks.
