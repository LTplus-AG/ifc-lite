---
"@ifc-lite/server-bin": minor
"@ifc-lite/server-client": minor
---

Expose the 2D symbol stream (`IfcAnnotation` + `IfcGrid`) from **all** Server
geometry/parsing endpoints, not just `POST /api/v1/parse` (issue #900).

Issue #843 added `symbolic_data` to the synchronous JSON parse response, but the
streaming and binary-Parquet endpoints still dropped it, so consumers couldn't
get IfcAnnotation/IfcGrid data unless they used that one endpoint. This brings
the whole API to parity with `@ifc-lite/parse`.

Server (shipped in the `@ifc-lite/server-bin` binary):

- `POST /api/v1/parse/stream` and `POST /api/v1/parse/parquet-stream` now carry
  `symbolic_data` in their `complete` SSE event. It's extracted once at the end
  of the shared streaming pipeline (`process_streaming`), so both endpoints get
  it without re-parsing.
- `POST /api/v1/parse/parquet` and `POST /api/v1/parse/parquet/optimized` extract
  the symbol stream alongside geometry (in parallel via `rayon::join`) and cache
  it under `{cache_key}-symbolic-v1`.
- New `GET /api/v1/parse/symbolic/{cache_key}` returns the symbol stream as JSON
  for the binary transports whose payloads can't carry it inline — mirroring how
  the data model is cached and fetched (`/api/v1/parse/data-model/{cache_key}`).
  Returns `202` while a streaming upload is still caching in the background.
- `POST /api/v1/parse` and the cached-geometry fast paths populate the same
  `{cache_key}-symbolic-v1` entry, so the fetch endpoint works regardless of
  which endpoint first processed the file.

Symbol data can be large for annotation-heavy drawings, so it travels in the
response body / SSE payload (JSON paths) or via the dedicated fetch endpoint
(binary paths) — never an HTTP header.

The parquet geometry cache version is bumped (`v2` → `v3`) so models cached
before the symbolic sidecar existed are reprocessed once and get their
`{cache_key}-symbolic-v1` companion written, instead of serving symbol-less
geometry while the symbolic endpoint returns `202` forever.

Client (`@ifc-lite/server-client`):

- New `SymbolicData` type (plus `SymbolicGridAxis`, `SymbolicPolyline`,
  `SymbolicCircle`, `SymbolicText`, `SymbolicFillArea`).
- `symbolic_data?` added to `ParseResponse`, `StreamCompleteEvent`,
  `ParquetStreamCompleteEvent`, and `ParquetStreamResult`.
- New `client.fetchSymbolic(cacheKey)` method (parallel to `fetchDataModel`) for
  the binary Parquet transports; `parseParquetStream` now returns `symbolic_data`
  on its result (inline from the stream, or fetched on the cache-hit fast path).

Regression coverage: in-process HTTP integration tests
(`apps/server/src/parity_tests.rs`) drive a grid + annotation + wall fixture
through `/parse`, `/parse/parquet`, `/parse/parquet/optimized`, the new symbolic
endpoint, and `process_streaming`, asserting each surfaces the grid axes and
annotation circle.
