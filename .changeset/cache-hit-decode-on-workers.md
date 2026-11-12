---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

A cache hit now inflates and decodes its geometry chunks on the cache workers, and starts them when the entry's header is read, so they decode while the main thread decodes the metadata. Each chunk's meshes come back in one message whose arrays are transferred, not copied; appearance sources shared through the section pool keep their identity. `ChunkInflatePool.decode` and the `decode` option of `openGeometryChunksV13` (type `ChunkDecode`) are new. A worker failure decodes on the calling thread exactly as before, and a chunk that does not decode anywhere is a `CorruptChunkError`.

Review fixes: closing the pool (`close()`) makes in-flight and later requests reject with `ChunkPoolClosedError`, and nothing is decoded on the calling thread for a closed load. `ChunkInflatePool.decodeOnWorkers` decodes on a worker only (rejecting with `NoChunkWorkerError` when none can take the chunk), for work ahead of the consumer. The viewer parses the entry's geometry head once and shares it with the prefetch, bounds the work ahead to four chunks per worker, stops it when the workers fail, and loads the pool module when the hit starts so the first chunks are posted before the metadata decodes.
