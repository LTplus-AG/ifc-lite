---
"@ifc-lite/bcf": minor
---

`createBCFFromIDSReport` now gives every viewpoint without a snapshot a small placeholder PNG in `snapshotData`. BIMcollab Zoom on Windows treats a viewpoint without a `<Snapshot>` as missing ("This issue has no viewpoint to zoom to") even when its camera and components are valid. The #7974 reporter saw the same in Revit, Navisworks and Dalux. Snapshots passed through `entitySnapshots` are unchanged. Written archives and BCF-API uploads of these projects therefore include the placeholder image. New exports: `fillMissingSnapshots(project)` applies the same fallback to any project, `placeholderSnapshotPng()` returns its bytes, and `isPlaceholderSnapshot(viewpoint)` detects it, including after a round trip, so previews and reports can skip it.
