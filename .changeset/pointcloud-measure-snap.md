---
'@ifc-lite/renderer': minor
---

Measure tool now snaps to real point-cloud (LAS/LAZ/E57/PLY/PCD, streamed or
inline IFCx) points, not just IFC mesh geometry (#1860).

Each point-cloud asset builds a CPU spatial index (`PointCloudSpatialIndex`,
internal) incrementally as chunks stream in, since the GPU vertex buffer
upload otherwise discards positions. `RaycastEngine.raycastSceneMagnetic`
(used by the measure tool) now queries this index alongside the existing
mesh raycast. A scan point never hides behind a mesh surface in front of
it, and it only overrides an existing mesh vertex/edge/face snap when it
is meaningfully in front of that surface (beyond its own screen-space
tolerance) — so a scan draped over its as-designed model cannot steal
intended vertex snaps via capture noise, while a cloud on its own (no
mesh loaded at all) is fully pickable. Points of LAS classes hidden via
the class visibility mask are not snappable. The index is disposed with
its owning `PointCloudNode`, mirroring the existing GPU-buffer teardown.

Point snapping respects the caller's snap configuration: with every mesh
snap kind disabled (the viewer's snap toggle OFF) scan points are not
grabbed either, and an explicit `SnapOptions.snapToPointClouds` overrides
that default in either direction. The snap tolerance is camera-aware —
linear in ray depth under perspective, constant under orthographic
projection.

Additive API: `SnapType.POINT_CLOUD` on the exported `SnapType` enum, and
the optional `SnapOptions.snapToPointClouds` flag.
