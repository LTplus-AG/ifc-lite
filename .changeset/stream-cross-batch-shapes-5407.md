---
"@ifc-lite/server-bin": minor
---

The streaming Parquet route can now share geometry across batches (#5407). With `?parquet_layout=shared-shapes&stream_shapes=cross-batch`, `POST /api/v1/parse/parquet-stream` sends each distinct shape once for the whole stream, as `POST /api/v1/parse/parquet` already did for the whole model, instead of once per batch. You no longer have to pick between the small shared payload and the bounded memory of a streamed parse. A batch carries only the shapes no earlier batch sent. Its mesh rows can point back into earlier batches, and every `batch` event states `vertex_base` / `index_base`. Server memory stays bounded: across batches it keeps where each distinct shape landed, plus at most 256 MiB of template meshes for rotated repeats. On five fixtures, the streamed payload is 2.2x to 6.8x smaller than the batch-local shared stream, with the same vertex rows as the buffered route.

It is a separate opt-in because a client that decodes each batch on its own would misread rows that point back. Without it, and on every other route, output is byte-identical to before. `stream_shapes=cross-batch` on the default flat layout answers `400`.
