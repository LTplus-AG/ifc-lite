# COPC view-dependent streaming

Issue #6869 (charter #6868). How a COPC point cloud reaches the screen without
ever holding more than a fixed number of points, and which invariants each layer
guarantees.

## Layers

| Layer | Where | Owns |
|---|---|---|
| Range reading | `@ifc-lite/pointcloud` `BlobByteSource`, `HttpRangeSource` | bytes `[start, end)`; HTTP refuses servers that ignore `Range` |
| COPC reader | `pointcloud/src/copc/*` | header + `copc`/`info` VLR, hierarchy pages (bounded iterative walk), per-node decode with laz-perf `ChunkDecoder` in the decode worker |
| LOD selection | `pointcloud/src/lod/*` | pure: frustum cull, priority refinement by projected span, node cap, water-filled budget, pacing |
| Residency | `apps/viewer/src/hooks/ingest/copc/copcLodController.ts` | which nodes are on the GPU; the budget ceiling; never retiring a view before its replacement is resident |
| Viewer glue | `copcLodStream.ts`, `copcLodSink.ts`, `copcLodCamera.ts` | detection, camera watching, keyed renderer chunks, scan cache, class histogram, deviation refresh |
| Renderer | `packages/renderer/src/pointcloud/point-cloud-keyed-chunks.ts` | removable chunks inside one asset, each with its own snap index |

## One asset, keyed chunks

A COPC model is ONE renderer asset, like any streamed scan, so picking,
placement, alignment, visibility, federation relabelling and the model
lifecycle stay keyed by one handle. Each octree node is appended as a keyed
chunk (`Renderer.appendPointCloudChunk(handle, chunk, nodeId)`) and removed
with `Renderer.removePointCloudChunk(handle, nodeId)`. Because draw, GPU
picking and deviation iterate the asset's chunks, and the crop box, section
plane, colour modes, class mask and EDL are per-asset uniforms, all of them
cover exactly the resident nodes. Measurement snapping covers them through
per-key snap indexes (`PointCloudSpatialIndex` has no removal).

## Detection and the load path

`ingestPointCloud` calls `streamPointCloudOrCopc` instead of
`streamPointCloud`. For a LAS/LAZ blob it reads the first `COPC_PROBE_BYTES`
and takes the LOD path only when the first VLR is `copc`/`info`; the file name
is irrelevant. Format-dependent behaviour (map units, CRS, alignment) is the
LAS/LAZ behaviour, because COPC is LAZ.

## Residency invariants

- **Budget.** Resident points never exceed the budget (default 10 M,
  `DEFAULT_COPC_POINT_BUDGET`). Room is made by evicting the least recently
  wanted node outside the current full-budget selection, then keep-set nodes
  holding more than their share; a node that still does not fit is skipped.
- **No holes.** Nothing leaves the screen for a camera move until a pass for
  the new view is complete (`shouldReplacePass`). A denser copy of a node
  replaces a thinner one in one synchronous step.
- **Superseded views stay quiet.** A newer camera aborts the older update; its
  in-flight reads are cancelled in the worker and never reach the renderer.
- **Strides are powers of two**, so small budget shifts do not refetch nodes.

## Side channels

- **Scan cache** (section scan layer, alignment workbench): fed once per
  coarse node (levels 0-2), an even subsample of the whole cloud.
- **Class histogram**: each node counted once, scaled by its stride: an
  estimate of the whole file's classes.
- **Deviation**: when a deviation run is live, each settled pass re-runs it
  (the triangle BVH is cached, so this is the per-chunk dispatch).

## Known limits

- Asset bounds only grow as nodes arrive (as for every streamed scan); the
  coarse overview loaded first already spans the cloud.
- After a GPU device loss the stream stops; reload the file.
- Remote (URL) COPC is supported by the reader (`HttpRangeSource`) but the
  viewer opens COPC through the canonical File path only.
- Software WebGPU (SwiftShader) renders millions of splats per frame slowly;
  `GPUQueue.writeBuffer` then blocks on GPU-process back-pressure. Hardware
  GPUs stream at full rate.
