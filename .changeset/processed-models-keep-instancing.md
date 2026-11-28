---
"@ifc-lite/geometry": minor
"@ifc-lite/server-client": minor
"@ifc-lite/viewer": patch
---

Server-processed models keep their instancing in the viewer. The server already sends each repeated shape once (`parquet_layout=shared-shapes`, and `stream_shapes=cross-batch` on the stream), but the client copied that shape into one flat mesh per occurrence, so a processed model reached the GPU with several times the triangles of a local parse of the same file.

- `@ifc-lite/server-client`: a new decode-only `sharedShapes` option on `parseParquet` and `parseParquetStream` returns rows that share a vertex block as `shared_shapes` (one block and its occurrences, each with its `origin` and rotation) instead of copies in `meshes`. Off by default; `decodeParquetGeometryShapes` is the blob-level entry point. Payloads without shared blocks, such as `-parquet-v5` caches, decode to the same flat meshes as before.
- `@ifc-lite/geometry`: `encodeInstancedShard` writes the IFNS instanced-shard format from TypeScript (the same bytes and version rules as the Rust encoder).
- Viewer: shared shapes become IFNS shards on the same queue a local parse feeds, under the local partition's rules (opaque, occurrence geometry, not a class with a whole-class toggle, at least 8 occurrences model-wide). Everything else is drawn flat as before. Like a local parse's, `totalTriangles` and `totalVertices` now count flat meshes only.
