---
"@ifc-lite/pointcloud": patch
"@ifc-lite/viewer": patch
---

Three Codex review fixes on the streaming ingest path.

**Streamed point cloud assets leaked across model removal.** The
renderer handle returned from `beginPointCloudStream` was discarded,
and streamed nodes are intentionally outside the IFCx
`setPointClouds` bucket, so removing a model left the GPU buffers
allocated for the rest of the session. `FederatedModel` now carries
an optional `pointCloudHandleId`; both ingest sites populate it; a
new `usePointCloudLifecycle` hook diffs the model map on every
change and frees handles for models that disappear.

**Double cleanup on ingest failure.** The outer `try/catch` in both
ingest sites called `removePointCloudAsset` + `incCount(-1)`, but
`ingestPointCloud`'s `onError` already does the same before
rethrowing. The duplicate cleanup pushed the asset counter negative
and caused a "remove twice" warning. The outer `catch` now only
handles store / UI state.

**PCD header probe.** The streaming source used the file's reported
size as the upper bound for the header probe; on truncated files
that walked off the end with a confusing error. Capped the probe at
4 KiB so malformed PCD headers fail with a clear "header > 4 KiB"
message.
