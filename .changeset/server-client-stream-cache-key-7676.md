---
'@ifc-lite/server-client': major
---

**Migration: `StreamCompleteEvent.cache_key` (the `complete` event of `parseStream()`) is now optional and deprecated: a server that includes #7676 no longer sends it. `/parse/stream` caches nothing, and the value it sent named no cache entry. Use `parse()` or a Parquet method when you need a `cache_key`.**
