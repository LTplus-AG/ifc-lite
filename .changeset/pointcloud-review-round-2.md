---
"@ifc-lite/pointcloud": patch
"@ifc-lite/renderer": patch
"@ifc-lite/ifcx": patch
"@ifc-lite/viewer": patch
---

Round 2 of CodeRabbit review fixes — correctness + robustness.

P1 (real correctness):
- Federation: streamed point clouds now get the post-`idOffset` global
  expressId in picking output. New `Renderer.relabelPointCloudAsset()`
  updates a per-asset uniform (`flags.x`) the shader prefers over the
  per-vertex attribute, so federation is just a metadata write — no
  GPU buffer rewrite. `useIfcFederation.addModel` calls it after the
  pointClouds offset is applied.
- Section-plane range now folds in `pointCloudRenderer.getBounds()`, so
  pure point-cloud scenes don't fall through to `[-100, 100]` and mixed
  scenes don't clip points outside a smaller mesh-only range.
- `recomputeModelBounds()` now recomputes from scratch (mesh baseline +
  current pc bounds) instead of growing-only. Previously, removing one
  of several point clouds left stale oversized extents until every
  point cloud was gone.
- `streamPointCloud` validates `chunkSize > 0` upfront; `LasStreamingSource`
  and `LazStreamingSource` reject `maxPoints <= 0`. Prevents
  zero-progress decode loops from accidental misuse.
- E57 merge uses `some()` instead of `every()`; mixed-attribute files
  no longer drop colour/intensity for the whole merged cloud just
  because one scan lacks the channel.
- E57 intensity is now allocated for `Integer`-encoded prototypes too
  (was silently dropped); `ScaledInteger` throws a clear error.

P2 (robustness):
- `xml-mini` rejects truncated input — unclosed elements throw instead
  of silently returning a partial tree.
- `worker-client.next()` now sends a `kind: 'abort'` to the worker when
  the signal fires mid-flight. Previously cancel returned to the caller
  while the worker kept decoding.
- `decodePointsArray` rejects empty arrays (was producing ±Infinity
  bbox); `decodePointsBase64` rejects empty strings (no silent
  downgrade to uncoloured cloud).
- `transformPositionsZUpToYUp` guards against zero / non-finite
  homogeneous `w` (malformed `usd::xformop` matrices).

P3 (polish):
- `POINT_CLOUD_DEFAULTS` is now an exported constant shared by the
  slice initializer and `resetViewerState`, so the two paths can't
  drift.
- Replaced `as any` cast around `AbortSignal.any` with a typed
  intersection.
- Doc comment on `pointCloudSizeMode` now matches the actual default
  (`fixed-px`).

Verified: 61 pointcloud unit tests pass, full repo typecheck (24/24),
test suite green (22 runs), viewer Vite build emits decode-worker
chunk correctly.
