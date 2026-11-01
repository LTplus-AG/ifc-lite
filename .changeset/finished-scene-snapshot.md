---
"@ifc-lite/renderer": major
"@ifc-lite/viewer": patch
---

A scene can now be saved and reopened whole. `encodeSceneSnapshot` and `decodeSceneSnapshot` serialize the batches finalize produced, and `SceneContents` gains the required methods `captureNextFinalize`, `adoptSceneSnapshot`, `hydrateSceneSnapshot`, `abandonSceneSnapshot`, `isSceneSnapshotHydrating` and `sceneSnapshotPolicy`, so a class implementing that interface must add them. The viewer uses them behind the default-off `perf.sceneSnapshot` flag, so a reopen of a single cached model can draw the complete model before its metadata decodes.
