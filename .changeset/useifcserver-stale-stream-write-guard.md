---
"@ifc-lite/viewer": patch
---

Fix `loadFromServer`'s streaming path writing a superseded load's geometry into the model the user just opened.

`useIfcCache.ts`'s `isStale` doc claims the same re-check contract as `loadFromServer`'s, but the streaming batch callback passed to `client.parseParquetStream` (and the post-stream/post-parse writes on all three server paths) never re-checked `isStale` after their awaits. A user opening file B while file A was still streaming from the server kept getting A's later batches painted into B's slot, including the trailing progress line reaching `Complete` for a load nobody owned any more. `loadFromServer` now re-checks `isStale` inside the batch callback and after each of the streaming/Parquet/JSON awaits, matching `loadFromCache`'s per-chunk guard, and returns `false` for a superseded load instead of reporting success.
