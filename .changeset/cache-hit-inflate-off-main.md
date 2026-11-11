---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

A cache hit inflates its compressed geometry chunks on a few workers instead of the main thread. `ChunkInflatePool` runs the same `inflateRaw` in the cache's compression worker (new `inflate` request) and falls back to inflating on the calling thread if a worker fails; `openGeometryChunksV13` and `decodeGeometryChunk` accept the inflate function to use.
