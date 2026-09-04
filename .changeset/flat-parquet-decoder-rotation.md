---
'@ifc-lite/server-client': minor
---

`decodeParquetGeometry` now applies the per-mesh rotation the flat Parquet transport carries under the server's shared-shape layout (#3888), and the client asks for that layout by default. Occurrences of one shape share a single block of vertices there, and `rot0..rot8` plus `origin_x/y/z` are what put each of them back where it belongs (`world = origin + R * p`) — decoding without the rotation draws every occurrence of a shared shape unrotated at the template's placement.

It is the same `applyInstanceRotation` the optimized decoder has used since #3575, on the same columns in the same frame, rather than a second implementation. A payload without the rotation columns decodes exactly as before: absent means identity, and a partial or short block (truncated wire data) also falls back to identity rather than reading `undefined` into the matrix.

The opt-in signal (`parquet_layout=shared-shapes`) is sent on all four endpoints that touch the flat geometry cache — the two parse routes, the cache check and the cached-geometry fetch — because the two layouts are stored under separate keys and a check that omitted it would answer about the other entry. The optimized route does not get the parameter; it has its own format and its own key.

**A pinned older copy of this package keeps working**, and that is the point of the opt-in: it never sends the signal, so an upgraded server keeps producing the layout it understands. Upgrading is what gets you the smaller payload.

One thing to check if you consume `MeshData` from the flat route directly: `origin` was `[0, 0, 0]` on every row from a default native server until now, so code that folded it in and code that ignored it behaved identically there. Under the shared-shape layout it carries real values, and world-space consumers must fold it. (`IFC_LITE_LOCAL_FRAME` has made native origins non-zero since #1841, so a deployment that sets it was already relying on that.)
