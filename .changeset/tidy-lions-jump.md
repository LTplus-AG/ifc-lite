---
"@ifc-lite/server-client": patch
---

Carry the canonical per-mesh `origin` and `geometry_class` through the server
geometry wire contract (issue #1841). The server parquet serializers previously
dropped both, so origin-relative geometry collapsed onto the world origin and
deduplicated (instanced) elements — e.g. repeated slabs — rendered every
occurrence at the shared template coordinates ("N slabs collapse to one"). Both
the standard and the optimized (instanced) parquet paths now emit the origin (in
the same Y-up frame as positions; the optimized path carries it per instance so
deduplicated templates place correctly) and `geometry_class`, and the decoders
populate `MeshData.origin` / `MeshData.geometry_class` — matching the canonical
`@ifc-lite/geometry` `MeshData`. Additive and backward-compatible: absent
columns decode as origin `[0,0,0]` / class `0`, so world-baked payloads and
caches from older servers are unaffected.
