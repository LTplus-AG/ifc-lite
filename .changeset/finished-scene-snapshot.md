---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

A scene can now be saved and reopened whole. `encodeSceneSnapshot` and `decodeSceneSnapshot` serialize the batches finalize produced, and `SceneContents` gains `captureNextFinalize`, `adoptSceneSnapshot`, `hydrateSceneSnapshot`, `abandonSceneSnapshot`, `isSceneSnapshotHydrating` and `sceneSnapshotPolicy`. The viewer uses them behind the default-off `perf.sceneSnapshot` flag, so a reopen of a single cached model can draw the complete model before its metadata decodes.
