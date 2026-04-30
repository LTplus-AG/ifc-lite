---
"@ifc-lite/pointcloud": patch
"@ifc-lite/renderer": patch
"@ifc-lite/ifcx": patch
"@ifc-lite/viewer": patch
"@ifc-lite/geometry": patch
---

Address CodeRabbit + Codex review feedback on PR #608.

Critical visual / correctness fixes:
- Point splats rendered ~2× too large because the shader treated the
  user-facing `pointSizePx` (diameter) as the splat radius. Fixed in
  both the live splat shader and the picker shader so click targets
  match the rendered disc.
- Routed every detected point-cloud format (`ply`, `pcd`, `e57`) through
  the streaming ingest in both `useIfcLoader` (single-file drop) and
  `useIfcFederation` (multi-file). Previously only `las/laz` got the
  pointcloud branch; `ply/pcd/e57` fell through into the IFC STEP path.
- Federation: applied `idOffset` to `geometryResult.pointClouds` too so
  multi-pointcloud-model loads don't collide on local `expressId`.
- `expressId` defaulted to `1` on every ingest, so multiple inline LAS
  loads collided. Now uses a process-local synthetic counter.
- E57 integer color channels are commonly u16 (0..65535); reader was
  forcing u8 reads, distorting RGB. Now picks element width from the
  declared min/max range.
- PCD `applyStride` preserved positions + colors but dropped intensity
  and classification, so those color modes silently broke on files
  past the 25M-point downsample cap.
- Inline `uploadAssetToGpu` forwards `intensities` + `classifications`
  (added to `PointCloudAsset.chunk` shape).
- Model bounds recomputed after `removePointCloudAsset` /
  `clearPointClouds` — previously stayed oversized, breaking
  fit-to-view and section sliders.
- `usePointCloudLifecycle` disposes a model's GPU asset when the model
  stays in the store but its `pointCloudHandleId` changes (re-stream of
  the same file used to leak the old handle).
- `resetViewerState` now clears the point-cloud slice runtime fields so
  loading a new file doesn't inherit the previous file's color mode /
  size / EDL state.

Correctness / robustness:
- `streamPointCloud`'s host now closes the source on probe + onOpen
  failures (single try/finally wrapping the whole open-and-decode
  flow), so worker-backed sources don't leak the decoder on parse
  errors or aborts.
- `worker-client.close()` clears cached `info`; subsequent `open()`
  actually re-opens instead of returning stale info next to a null
  `sourceId`.
- `LasStreamingSource.open()` and `LazStreamingSource.open()` are
  atomic on failure: state is committed only after every step
  succeeds, so a retry rerruns the probe + RGB-scale detection
  cleanly. LAZ also frees malloc'd wasm pointers in the catch path.
- PLY decoder rejects files where `vertex` isn't the first element
  (decoder reads from `header.bodyOffset`; non-leading vertex would
  silently produce garbage).
- `decodePointsArray` validates each `colors[i]` is a `[r,g,b]` triple
  before indexing, so malformed schemas fail with a clear message.
- `useIfcLoader` LAS/LAZ/PLY/PCD/E57 branch is guarded by
  `loadSessionRef` on both error and success paths so a newer load can
  replace an in-flight one without overwriting the newer model state;
  stale renderer handle is freed.

Critical webhook fixes:
- `ViewportOverlays.tsx` had three imports between executable code;
  hoisted them above the `const isDesktop = isTauri()` declaration.
- `edl-pass.ts` used `0u` for `texture_depth_multisampled_2d`'s
  `sample_index`; WGSL spec requires `i32`.
- `pcd.test.ts` switched from `__dirname` to
  `fileURLToPath(import.meta.url)` so it works outside vitest's
  CommonJS-compat shim.

UX polish:
- `PointCloudPanel` toggle buttons expose `aria-pressed` so screen
  readers announce the active option.
- `pointCloudSlice` setters reject `NaN`/`Infinity` (Math.min/max
  passes them through unchanged).
- `BlobByteSource.read` clamps a negative `start` to `0`.
- File-dialog filters split GLB out of the IFC bucket into a "Mesh
  Files" group.

The flattenMatrix transpose flagged in the review is actually correct
for USD's row-major-with-translation-in-row-3 convention (verified by
inspecting the Point_Cloud_S1 sample's transform; the rendered scan is
at the right world position). Added a clarifying comment so future
reviewers don't reach for the wrong fix.
