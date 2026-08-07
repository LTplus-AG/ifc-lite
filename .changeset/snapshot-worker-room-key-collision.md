---
"@ifc-lite/collab-server": patch
---

Fix `SnapshotWorker` overwriting one room's `.ifcx` snapshot with another's. The output filename was built with the lossy `[^a-zA-Z0-9._-] -> _` sanitizer, which maps distinct room ids (e.g. `proj/alpha` and `proj:alpha`) onto the same name; with the timestamp component at millisecond resolution, two such rooms snapshotted in the same tick wrote to one path and the second silently replaced the first — while `runOnce()` returned a successful `SnapshotResult` for both, each reporting its own `byteLength`. The path now uses `encodeURIComponent`, matching `FilePersistence.logPath` and `S3Persistence.safeRoom`, whose comments already document why the lossy map is unsafe for a durable key. Ids the old sanitizer left unchanged (UUIDs, room codes) encode identically, so existing snapshot filenames are unaffected.
