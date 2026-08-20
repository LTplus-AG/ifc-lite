---
"@ifc-lite/server-client": patch
---

Fix two `server-client` request paths that had drifted from their siblings.

`parseParquetStream`'s SSE reader was never released on a throwing path (a
terminal `error` event, or any exception mid-loop) — `response.body`'s
`ReadableStreamDefaultReader` stayed locked, leaking the underlying
connection. `parseStream` already wraps its identical read loop in a
`try`/`finally` that calls `reader.releaseLock()`; `parseParquetStream` now
does the same.

`getCached` (`GET /api/v1/cache/{key}`) never sent the configured bearer
token, even though every other request method does via `authHeaders()` and
the route is one of the server's `protected_routes` (bearer-gated whenever
`IFC_SERVER_API_TOKEN` is set). A client configured with `token` would get a
401 from `getCached` while every other call succeeded.
