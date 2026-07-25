---
'@ifc-lite/renderer': minor
---

Measure tool now snaps to real point-cloud (LAS/LAZ/E57/PLY/PCD, streamed or
inline IFCx) points, not just IFC mesh geometry (#1860).

Each point-cloud asset builds a CPU spatial index (`PointCloudSpatialIndex`,
internal) incrementally as chunks stream in, since the GPU vertex buffer
upload otherwise discards positions. `RaycastEngine.raycastSceneMagnetic`
(used by the measure tool) now queries this index alongside the existing
mesh raycast: whichever hit is nearer along the ray wins, so a scan point in
front of — or on its own with no mesh loaded at all — is now pickable. The
index is disposed with its owning `PointCloudNode`, mirroring the existing
GPU-buffer teardown.

Point snapping respects the caller's snap configuration: with every mesh
snap kind disabled (the viewer's snap toggle OFF) scan points are not
grabbed either, and an explicit `SnapOptions.snapToPointClouds` overrides
that default in either direction. The snap tolerance is camera-aware —
linear in ray depth under perspective, constant under orthographic
projection.

Additive API: `SnapType.POINT_CLOUD` on the exported `SnapType` enum, and
the optional `SnapOptions.snapToPointClouds` flag.
