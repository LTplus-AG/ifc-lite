---
"@ifc-lite/renderer": minor
---

Add `Camera.setOrbitAnchorBounds(bounds | null)` / `getOrbitAnchorBounds()` — an outlier-robust orbit-pivot anchor distinct from the full-scene `sceneBounds`. The renderer keeps `sceneBounds` pinned to the full model AABB (needed for near/far clipping and section ranges), but a handful of far-flung meshes can push that AABB's centre into empty space; when the anchor is set, the orbit-pivot fallback rotates around the tighter centre instead. Part of the fix for the model disappearing during orbit on sparse/outlier models (#1394).
