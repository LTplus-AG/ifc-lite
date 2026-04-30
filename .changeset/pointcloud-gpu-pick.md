---
"@ifc-lite/renderer": minor
---

GPU-based point picking, federation-aware.

Clicks on point cloud splats now resolve through the existing `Picker`
flow and return `PickResult{expressId, modelIndex}` exactly like mesh
picks. Selection / hover / measurement all participate without further
plumbing.

How it works:
- New `PointPicker` runs a second pipeline in the same `r32uint`
  picking pass as the mesh picker. Splats inflate by an extra 2 px of
  click tolerance, then write `0x80000000 | (expressId & 0x7FFFFFFF)`.
- `Picker.pick()` accepts an optional `pointNodes` + `pointSizing`
  argument. Both pipelines share the same depth buffer, so points
  occlude meshes and vice versa during the pick.
- Bit 31 of the readback distinguishes mesh vs point hits.
- `PickingManager` exposes `setPointPickProvider()` so the renderer can
  hand it a fresh node snapshot + sizing per pick — keeps the manager
  decoupled from `PointCloudRenderer`.

Round mask matches the live splat shader: picking the corner area of a
splat that's outside the rendered disc returns null, so the click
target visually matches what the user sees.

A follow-on will add depth-texel readback to recover the picked world
position (XYZ + classification + intensity) for hover tooltips —
deferred so this lands clean.
