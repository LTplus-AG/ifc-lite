---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

The first reopen of a cached model now draws its stored scene instead of streaming the cache: a cold load keeps its finished scene and writes it beside the cache entry once the load is interactive and the page is idle. `encodeSceneSnapshotInSlices` encodes a scene snapshot with a yield between slices, producing the same bytes as `encodeSceneSnapshot`.
