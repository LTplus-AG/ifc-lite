---
"@ifc-lite/renderer": minor
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

The first reopen of a cached model now draws its stored scene instead of streaming the cache: a cold load keeps its finished scene and writes it beside the cache entry once the load is interactive and the page is idle. `encodeSceneSnapshotInSlices` encodes a scene snapshot with a yield between slices (same bytes as `encodeSceneSnapshot`); `captureNextFinalize` also reports the mesh each piece was queued from and, through an optional second callback (`SceneCaptureDrop`), why an armed capture ended without a snapshot; and `reorderSnapshotPieces` moves a snapshot's piece ordinals to another decode order. `CacheWriteOptions.onGeometryOrder` reports the order the entry stores the meshes in.
