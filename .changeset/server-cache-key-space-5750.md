---
'@ifc-lite/server-bin': minor
---

`GET` and `DELETE /api/v1/cache/{key}` now take the same key: the `cache_key` a parse returned. Both resolve it through one function, so a key one accepts the other accepts, and anything else is a `400` from both. `DELETE` used to take the bare SHA-256 hash instead, so passing `result.cache_key` to both methods got a hit from one and a `400` from the other; **callers of `DELETE` must now pass the `cache_key`** (the hash alone is refused). It still removes every cached variant of that source file. A cache `GET` now holds a parse admission slot while it decodes the stored model, so concurrent reads of a large model are bounded like parses and can answer `503 OVERLOADED` with `Retry-After`; a miss needs no slot.

Every error response now uses the same `{"error", "code"}` JSON body. Extractor rejections (a bad query value, a non-multipart upload), `/api/v1/metrics` while disabled, the bearer-token `401` (now with `WWW-Authenticate: Bearer`), the `/api/v1/cache/check/{hash}` miss, unknown routes, wrong methods, the request timeout and caught panics used to answer with `text/plain` or an empty body. Status codes are unchanged.
