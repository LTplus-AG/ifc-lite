---
"@ifc-lite/cache": patch
---

Reject a NaN/Infinity-bombed vertex position or normal in a cached geometry section instead of silently decoding it. Every existing corruption guard in the binary cache validates declared SHAPE (section offsets, string-table offsets, row indices, chunk-directory contiguity); none constrained the numeric domain of a vertex float once its slot was in range. A byte-flip landing inside the position/normal data therefore passed every check and decoded as a syntactically valid, semantically poisoned mesh, which could reach the spatial index and renderer unfiltered. The cache reader now throws (and the viewer's cache-restore path already discards the entry and falls back to a fresh parse on any read failure).
