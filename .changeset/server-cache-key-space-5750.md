---
'@ifc-lite/server-bin': major
---

**Migration: `DELETE /api/v1/cache/{key}` no longer accepts the bare SHA-256 file hash. Pass the `cache_key` a parse returned (`result.cache_key`, e.g. `{sha256}-default`), the same key `GET /api/v1/cache/{key}` takes. A bare hash now answers `400 BAD_REQUEST`. Error bodies that were `text/plain` or empty are now JSON (`{"error","code"}`); status codes are unchanged.**

`GET` and `DELETE /api/v1/cache/{key}` now take the same key, the `cache_key` a parse returned, resolved through one function: a key one accepts the other accepts, and anything else is a `400` from both. Before, passing `result.cache_key` to both got a hit from `GET` and a `400` from `DELETE`. `DELETE` still removes every cached variant of that source file, and its response `key` field is now the `cache_key` it was given rather than the bare hash. A malformed key on `GET` is now a `400` rather than a `404`. A cache `GET` hit now holds a parse admission slot while it decodes the stored model, so concurrent reads of a large model are bounded like parses and can answer `503 OVERLOADED` with `Retry-After`; a miss needs no slot.

Every error response now uses the same `{"error", "code"}` JSON body. Extractor rejections (a bad query value, a non-multipart upload), `/api/v1/metrics` while disabled, the bearer-token `401` (now with `WWW-Authenticate: Bearer`), the `/api/v1/cache/check/{hash}` miss, unknown routes, wrong methods, the request timeout and caught panics used to answer with `text/plain` or an empty body.
