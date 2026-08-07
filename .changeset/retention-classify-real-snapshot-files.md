---
"@ifc-lite/collab-server": patch
---

Fix `planRetention`'s default classifier never matching a real `SnapshotWorker` output file, so `applyRetention` silently never reclaims any of it.

`SnapshotWorker.runOnce` (`snapshot-worker.ts`) writes one `<safeRoomId>.<isoStamp>.ifcx` file per active room on every tick and never overwrites or deletes a previous one. `retention.ts`'s `defaultClassify` only recognized `<roomId>.log` (active) and `<roomId>.log.<stamp>` / `<roomId>.snap.<stamp>` (rotated/snapshot) — shapes nothing in this package's `FilePersistence` or `SnapshotWorker` actually produces. Every real `.ifcx` snapshot was therefore classified `unknown` and skipped regardless of age or configured policy: `planRetention` returned an empty `drop` list and `applyRetention` freed 0 bytes even under an aggressive 1-day policy, while snapshot files accumulated on disk forever with no error surfaced. `defaultClassify` now also matches `*.ifcx` as `snapshot`, so it is governed by `snapshotsDays` like the (aspirational) `.snap.<stamp>` shape.
