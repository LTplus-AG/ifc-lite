---
'@ifc-lite/server-client': minor
---

`decodeParquetGeometry` now applies the per-mesh rotation the flat Parquet transport carries from `-parquet-v6` on (#3888). Occurrences of one shape share a single block of vertices in that layout, and `rot0..rot8` plus `origin_x/y/z` are what put each of them back where it belongs (`world = origin + R * p`) — decoding without the rotation draws every occurrence of a shared shape unrotated at the template's orientation.

It is the same `applyInstanceRotation` the optimized decoder has used since #3575, on the same columns in the same frame, rather than a second implementation. A `-parquet-v5` blob has no rotation columns at all and decodes exactly as before: absent means identity, and a partial or short block (truncated wire data) also falls back to identity rather than reading `undefined` into the matrix.

One thing to check if you consume `MeshData` from this route directly: `origin` was `[0, 0, 0]` on every row of a flat blob from a default native server until now, so code that folded it in and code that ignored it behaved identically there. From v6 it carries real values wherever a shape is shared, on every deployment, and world-space consumers must fold it.

**Upgrade this package with the server.** An older copy of it decodes a v6 blob without error and draws every occurrence of a shared shape at the template's placement — the flat transport has no version byte to fail loud on, and the server's `-parquet-v6` cache key does not gate client version.
