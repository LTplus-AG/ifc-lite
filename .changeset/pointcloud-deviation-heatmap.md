---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

BIM ↔ scan deviation heatmap — GPU compute pipeline that colours each
scan point by signed distance to the nearest mesh surface. Works with
every IFC ingest path (STEP / IFCx / GLB / federated) and with every
point cloud format (inline IFCx + streamed LAS / LAZ / PLY / PCD / E57
/ PTS / XYZ — anywhere `Scene.forEachMeshData` reaches and any node
the splat pipeline already renders).

Pipeline:
1. **Per-triangle BVH** built from `Scene.forEachMeshData()` —
   reaches every CPU-side `MeshData` regardless of source. Median
   split along longest axis, max 16 tris per leaf, flattened to a
   `Float32Array` of 32-byte nodes during the build (no second
   pass).
2. **Two GPU storage buffers** — nodes + triangles — uploaded once
   per mesh-set change. Cached by a `(meshCount, totalPositions)`
   fingerprint so re-running deviation against the same model is a
   pure dispatch.
3. **Compute shader** with stack-based BVH descent (workgroup-size
   64). Per point: descend BVH pruning by squared point-to-AABB
   distance, run Ericson §5.1.5 closest-point-on-triangle on every
   leaf candidate, output signed distance via the closest face's
   precomputed normal.
4. **Per-chunk deviation buffer** allocated alongside the splat
   vertex buffer (`STORAGE | VERTEX | COPY_DST`, 4 bytes per point,
   zero-initialised). Compute reads the vertex buffer's positions
   directly — no CPU copy of streamed clouds needed.
5. **Splat shader** gains a 2nd vertex buffer (location 4 = `f32`
   deviation), a new `deviation` color mode, and a diverging
   blue → white → red `deviation_ramp`. Uniform block grows by 16
   bytes (new `deviationRange: vec4<f32>` slot for centre + half-
   range), `POINT_UNIFORM_SIZE` 208 → 224.
6. **Public API** — `Renderer.computeDeviations({ maxRange?,
   forceRebuild? })` returns `{ bvhTriangles, bvhNodes,
   chunksProcessed, pointsProcessed, bounds, suggestedHalfRange }`.
   Awaits `queue.onSubmittedWorkDone` so callers see populated
   buffers when the promise resolves.
7. **UI** — new `DeviationPanel` inside `PointCloudPanel`. Compute
   button (gated on `triangleCount > 0`), live progress + duration
   readout, range slider in millimetres (1 mm to 1 m), inline
   blue-white-red legend. Auto-suggests a half-range from the BVH
   bbox (±max-extent / 1000) and auto-switches the colour mode to
   `deviation` on success.
8. **Slice** — `pointCloudColorMode` gains `'deviation'`, plus
   `pointCloudDeviationCenterOffset`, `pointCloudDeviationHalfRange`
   (default ±5 cm), and `pointCloudDeviationComputed`. Sync hook
   forwards the range to the renderer uniform.

Sign convention: positive = scan point is on the outward-normal
side of the closest triangle (typical "scan overshoots wall by
5 mm"). Negative = inside / behind. Non-watertight BIM (typical
IFC) means "inside the building" isn't globally defined, but
per-surface front/back is always meaningful.

Limitations / future work:
- The dispatch processes every uploaded point against every
  triangle in the scene; isolated / hidden meshes still contribute
  to the BVH. A `meshFilter` predicate is a natural follow-up.
- Histogram + auto-range from p5/p95 not yet implemented — the
  default half-range suggestion is a coarse bbox/1000 heuristic.
  Phase B will add a 2nd compute pass with atomic histogram.
- The BVH walk uses a 64-deep per-thread stack. Pathologically
  unbalanced trees (>64 deep) silently drop the deepest branch.
  Real BIMs don't get there; SAH or surface-area cost would help
  if we ever hit it.

Verified: full repo typecheck (24/24), 655 viewer tests, viewer
Vite build green.
