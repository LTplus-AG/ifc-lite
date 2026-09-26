---
'@ifc-lite/server-client': major
---

**Migration: `getCached(key)` now throws for a key that is not a request `cache_key`. Callers who followed the old docs and passed the bare SHA-256 file hash used to get `null`; against a server that includes #5750 they now get an `IfcServerError` with `status` 400 and `code` `BAD_REQUEST`. Pass `result.cache_key` (the `cache_key` a parse returned) instead. `null` still means "well-formed key, nothing cached".**

Errors from the server are now thrown as `IfcServerError`, which carries the HTTP `status` and the server's error `code` (`NOT_FOUND`, `BAD_REQUEST`, `UNAUTHORIZED`, `OVERLOADED`, ...). It extends `Error` and keeps the same `message`, so existing `catch` blocks are unaffected. A JSON body that is not the server's error envelope no longer produces the message `Server error (undefined): undefined`; it falls back to the HTTP status, with `code` set to `HTTP_<status>`. The `getCached` docs now say what `key` is: the `cache_key` a parse returned, not the bare file hash.
