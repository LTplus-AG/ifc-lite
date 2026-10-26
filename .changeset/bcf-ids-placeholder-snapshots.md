---
"@ifc-lite/bcf": minor
---

`createBCFFromIDSReport` now gives every viewpoint without a snapshot a small placeholder PNG. BIMcollab Zoom on Windows treats a viewpoint without a `<Snapshot>` as missing ("This issue has no viewpoint to zoom to") even when its camera and components are valid. The #7974 reporter saw the same in Revit, Navisworks and Dalux. Snapshots passed through `entitySnapshots` are unchanged. The new `fillMissingSnapshots(project)` and `placeholderSnapshotPng()` exports apply the same fallback to any project.
