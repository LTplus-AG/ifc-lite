---
"@ifc-lite/server-client": minor
---

Issue #1841: decode the server entity table into a compact columnar index (`ServerEntityIndex`) instead of a giant `Map<number, EntityMetadata>`, avoiding the V8 2^24 Map ceiling and reusing the canonical `CompactEntityIndex` for `entityIndex.byId`. `DataModel.entities` is now a `ServerEntityIndex` rather than a `Map` (minor bump): it keeps the raw decoded columns (`columns`) for indexed consumption and exposes a Map-compatible read surface (`size`/`get`/`has`/iteration/`keys`/`values`/`entries`/`forEach`), materializing `EntityMetadata` rows lazily via binary search over a sorted expressId view.
