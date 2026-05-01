---
"@ifc-lite/viewer": patch
"@ifc-lite/renderer": patch
"@ifc-lite/pointcloud": patch
---

Round 3 of point cloud fixes — correctness gaps that block multi-model
sessions and silent rendering stalls.

**Federation relabel for streamed point clouds.**
`ingestPointCloud` now emits a synthetic entry on
`geometryResult.pointClouds`. Without this, `useIfcFederation`'s
`idOffset` fold + `relabelPointCloudAsset` call never fired for
LAS/LAZ/PLY/PCD/E57 streams, so picked `expressId`s for streamed
assets collided across federated models.

**Sync-throw cleanup.** Wrap `streamPointCloud()` in `try/catch`
inside `ingestPointCloud`. The renderer asset and asset-count
increment happen before the worker spins up, so a sync throw during
validation/worker setup used to leak both. We now `removePointCloudAsset`
+ `onCountChange(-1)` before re-throwing.

**`setPointClouds()` shrinks bounds correctly.** The replace path
called `expandModelBoundsForPointClouds` (grow-only). Reloading IFCx
with a smaller scan kept stale extents until `clear`. Switched to
`recomputeModelBounds()` so bounds re-baseline from current state.

**`requestRender()` after every mutation.** `appendPointCloudChunk`,
`setPointCloudOptions`, `setEdlOptions`, `setPointClouds`,
`addPointClouds`, `clearPointClouds`, `removePointCloudAsset`,
`endPointCloudStream` now schedule a frame. Previously streamed
chunks could sit invisible until an unrelated camera move triggered
the next render.

**Worker cancel race.** `worker-client.next()` now re-checks
`signal.aborted` after `await session.send()`. A chunk that won the
race against `cancel()` would otherwise still call `onChunk` after
the host returned to the caller.

**Multi-scan E57 rejection.** `parseE57Xml` now records `hasPose` per
Data3D entry. `decodeE57` rejects multi-scan files where any entry
carries a `<pose>` element, with a clear "registered multi-scan;
re-export as merged" error. Previously such files silently
concatenated in scan-local space and rendered misaligned.

Verified: 62 pointcloud unit tests (1 new for pose flag), full repo
typecheck (24/24), viewer Vite build green.
