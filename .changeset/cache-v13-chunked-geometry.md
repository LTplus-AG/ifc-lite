---
"@ifc-lite/cache": minor
---

FORMAT_VERSION 13: chunked geometry section (issue #1682, phase 4 of the chunked-residency plan).

Geometry is now written as spatially coherent, byte-capped chunk records behind a directory (AABB + offsets + counts per chunk), each independently decodable and deflate-raw compressed via the native CompressionStream (2-3x smaller entries). New incremental API: `openGeometryChunksV13` / `readGeometryHeadV13` / `decodeGeometryChunk` for streamed cache-hit loads; `BinaryCacheReader.read()` keeps its shape (full decode). Per-mesh record layout is unchanged; the version bump rolls cache keys so old entries re-mesh.

BREAKING for pre-v13 files: the legacy sequential geometry reader/writer were removed - `read()` throws on pre-v13 geometry (the viewer's version-suffixed cache keys never hit such entries; the throw self-heals as discard-and-rebuild). The never-implemented `CacheWriteOptions.compress` placeholder was removed in favour of `compressGeometryChunks`.
