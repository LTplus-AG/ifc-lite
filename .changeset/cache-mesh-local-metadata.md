---
"@ifc-lite/cache": patch
---
Keep each mesh's optional `shadingColor`, pre-placement `localBounds` and `localToWorld` in binary geometry caches, so a cache hit carries the same values as a fresh load. Bump the cache format to v25; older entries remain readable with these fields absent and nothing is inferred.
