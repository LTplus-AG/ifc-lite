---
'@ifc-lite/renderer': patch
---

The opt-in draw stream now culls and picks LOD1 per batch like the per-batch loop. Its members draw in submission order, so coplanar ties and colour overrides on federated revisions resolve the same way with the stream on.
