# @ifc-lite/renderer

## 1.21.0

### Minor Changes

- [#723](https://github.com/LTplus-AG/ifc-lite/pull/723) [`b055b11`](https://github.com/LTplus-AG/ifc-lite/commit/b055b118c1ecf5250bb236a74d2da6ee85345c9f) Thanks [@louistrue](https://github.com/louistrue)! - Add `Scene.removeMeshesForEntity(expressId)` and `Scene.translateMeshesForEntity(expressId, delta)` plus their bulk variants so authoring actions can keep the rendered scene in sync with IFC mutations.

  `removeMeshesForEntity` drops GPU buffers + bbox + meshDataMap entry for a tombstoned entity instead of relying on the visibility set — used by the viewer's split / delete pathway.

  `translateMeshesForEntity` applies a renderer-frame delta in place on `MeshData.positions`, clears the entity's bounding-box cache, and marks affected buckets for re-batch on the next `rebuildPendingBatches`. Used by the viewer's `translateEntity` / `setEntityPosition` actions so the visible mesh follows the gizmo and the numeric-move card without a full reload.

  For color-merged meshes (per-vertex `entityIds`), both helpers skip the shared geometry and just de-register / leave-alone the requested entity — the geometry is still real, only the IFC tombstone says we should stop counting it.

## 1.20.1

### Patch Changes

- [#682](https://github.com/louistrue/ifc-lite/pull/682) [`cb15422`](https://github.com/louistrue/ifc-lite/commit/cb15422794118d1743d8a6027e5a1cff1e01e328) Thanks [@louistrue](https://github.com/louistrue)! - Fix lens / Pset colour rules silently failing on IfcSpace, IfcOpeningElement, and other transparent-by-default entity types (issue #677).

  The lens system paints colour overrides through a second pass whose pipeline uses `depthCompare: 'equal'`, so it only paints where the base draw already wrote depth. The transparent pipeline runs with `depthWriteEnabled: false`, so any colour rule targeting an entity that defaults to transparent (IfcSpace alpha 0.3, IfcOpeningElement alpha 0.4, glass, …) was silently dropped — the equality test never matched and the chosen colour never appeared.

  The renderer now consults `scene.getColorOverrides()` when classifying meshes and batches for the opaque-vs-transparent pipeline split. Meshes whose `expressId` carries an override at alpha ≥ 0.2 are promoted to the opaque pipeline so the base draw writes depth, and the overlay paint pass then paints the chosen colour on top. Ghost-tier auto-fades (alpha 0.15) are deliberately left in the transparent path to preserve existing fade behaviour for unmatched entities.

  Transparent batches with **mixed** override membership (e.g. a colour rule targeting only some IfcSpaces) are split into a "promoted" sub-batch (all overridden — opaque routing) and a "remaining" sub-batch (no overrides — transparent routing) via the existing partial-batch cache, so non-overridden batchmates keep their native transparent rendering. The classifier itself only promotes batches where every id is deliberately overridden.

  `Scene.getColorOverrides()` returns a `ReadonlyMap` view and `setColorOverrides` takes a defensive copy, so external callers can't mutate the renderer's pipeline-routing state out from under the overlay batches.

  Pure routing logic lives in a new `overlay-routing.ts` helper that's unit-tested without a GPU device (22 tests).

## 1.20.0

### Minor Changes

- [#650](https://github.com/louistrue/ifc-lite/pull/650) [`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158) Thanks [@louistrue](https://github.com/louistrue)! - Arbitrary-normal section planes with face-pick (Bonsai-style) and a
  properly-rendered cap on tilted planes (#243). Click any face in the
  section tool's "Pick" mode to cut through it; the kept half-space
  defaults to the side facing the camera. The cardinal "Down / Front /
  Side" presets are unchanged.

  Renderer:

  - New `planeBasis(normal)` + `nearestCardinalAxis(normal)` exports
    derive a deterministic in-plane basis used by both the cap renderer
    and the 2D cutter — without a single shared derivation the cap hatch
    rotated when state was reconstructed.
  - `SectionPlaneRenderOptions` and `SectionPlane` gain optional
    `normal` + `distance` fields. When set, the shader clips on that
    plane verbatim (no axis mapping, no building-rotation, no
    position-percentage math) and the gizmo renders as a violet quad
    oriented from `planeBasis(normal)`.
  - `Section2DOverlayRenderer.uploadDrawing` accepts an optional
    `customPlane = { origin, tangent, bitangent }`. When supplied it
    replaces the cardinal-axis 2D→3D coordinate swap with
    `origin + tangent·x + bitangent·y`, so the cap silhouette lands
    exactly on the tilted plane (the bug PR #581 hid by suppressing the
    cap entirely for non-cardinal planes).

  Drawing-2d:

  - `SectionPlaneConfig` gains an optional `customPlane`. `SectionCutter`
    uses it verbatim for the plane equation and projects intersections
    to 2D via `(dot(p − origin, tangent), dot(p − origin, bitangent))`,
    matching the cap renderer's lift exactly.
  - `DrawingGenerator` now rebuilds the CPU cutter on each `generate()`
    call so a switch from cardinal to custom (or between custom planes)
    takes effect immediately.

  Tests: 11 new viewer tests covering normalisation, sign-preserving
  cardinal mapping, basis orthonormality, half-space flip, slice
  clearing on cardinal preset, and degenerate-normal handling. 6 new
  renderer tests covering basis derivation across cardinal axes,
  near-axis tilts, and the +Y / −Y reference-axis boundary.

## 1.19.1

### Patch Changes

- [#645](https://github.com/louistrue/ifc-lite/pull/645) [`9d5f927`](https://github.com/louistrue/ifc-lite/commit/9d5f92774f8c1c29061523678aa7b406fa68e3e6) Thanks [@louistrue](https://github.com/louistrue)! - Fix GPU picker silently failing on small models. `Picker.pick()` was
  reading back a 1×1 `depth-only` texel for click-to-world unprojection,
  which WebGPU rejects — depth/stencil-format copies must cover the full
  subresource. Clicks on files small enough to take the GPU picker path
  (≤500 mesh pieces; larger models hit the CPU-raycast fallback) silently
  resolved to `null`, leaving no 3D highlight and no property panel. The
  depth readback now copies the full depth image and indexes the mapped
  buffer client-side; no shader, pipeline, or point-picker changes.
- Updated dependencies [[`1d6e99b`](https://github.com/louistrue/ifc-lite/commit/1d6e99bb23f67e20a192f362ba65ee73a8180f69), [`b6e83d3`](https://github.com/louistrue/ifc-lite/commit/b6e83d3ac4f04fe7c439bf282a25963c6db0b909), [`6f052c3`](https://github.com/louistrue/ifc-lite/commit/6f052c309a99edd1d9a6925d44bbc2aed6cd10a5), [`b8a8206`](https://github.com/louistrue/ifc-lite/commit/b8a82062c4392d05224561dda8a2767a8b7b1857)]:
  - @ifc-lite/wasm@1.16.10
  - @ifc-lite/geometry@1.18.1

## 1.19.0

### Minor Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Per-class visibility toggles for ASPRS-classified point clouds.

  A new "Classes" section in the point cloud panel exposes a checkbox
  list of every LAS 1.4 standard class (Ground, Vegetation, Building,
  Water, Wires, Bridge deck, ...). Toggling a class hides every point
  with that classification. Works in any colour mode; the swatch
  colours mirror the splat shader's classification palette so the UI
  matches what's on screen.

  Implementation:

  - New `pointCloudClassMask: number` (u32 bitmask, default
    `0xFFFFFFFF`) on the point cloud slice. `togglePointCloudClass(id)`
    flips a single bit; `setPointCloudClassMask(mask)` replaces all 32.
  - `PointCloudRenderOptions.classMask` plumbed through the renderer.
    Stored in uniform slot `flags.w` (was unused).
  - Splat shader checks `(flags.w >> classId) & 1` per vertex; hidden
    classes get a degenerate `clipPos = vec4(0, 0, -2, 1)` so they're
    culled before rasterisation rather than wasted on a fragment-stage
    discard.
  - New `PointCloudClasses` component in the panel renders a
    `<details>` collapsible with "Show all" + per-class toggles. A
    badge surfaces "N of 32 visible" when not all are on.
  - `usePointCloudSync` forwards the mask to
    `setPointCloudOptions({ classMask })`.

  Class ids ≥32 always show — the mask only covers the standard
  range. Custom-labelled scans need a richer UI (deferred).

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - BIM ↔ scan deviation heatmap — GPU compute pipeline that colours each
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

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Near-term UX features from #611.

  **Hover XYZ readback.** GPU pick now also samples the depth texel at
  the click position and unprojects it through the inverse view-
  projection. `PickResult` carries an optional `worldXYZ`. Reverse-Z is
  honoured (depth=1 = near, 0 = far / miss). The hover tooltip shows
  `x, y, z` (2 decimals) under the entity id. Useful for measurement
  hooks and point-cloud picks where the synthetic entity has no
  surface property to display.

  **Solid-color picker.** When the point-cloud panel's colour mode is
  set to `fixed`, a native `<input type="color">` swatch appears.
  Hex round-trips through the existing `[r,g,b,a]` store tuple.

  **Colour-mode legend.** A new `PointCloudLegend` component renders
  inline beneath the colour-mode buttons:

  - Classification → list of ASPRS LAS 1.4 class id / colour swatch /
    label (Ground, Vegetation, Building, ...). Palette mirrors
    `point-shader.wgsl.ts` exactly.
  - Intensity → black-to-white gradient bar with low/high labels.
  - Height → cool-warm gradient bar (blue → cyan → green → yellow →
    red), matching the shader's `height_ramp`.
    RGB and Solid don't render a legend.

  **Cancel button for in-flight streams.** New
  `activeStreamCanceller` field on the loading slice. Both ingest
  sites (`useIfcLoader`, `useIfcFederation`) register
  `() => streamHandle.cancel()` after starting and clear on success /
  error. `StatusBar` shows a Cancel button while the canceller is
  non-null. AbortError on cancel is reported as "Cancelled" rather
  than a scary error string.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - GPU rectangle pick (marquee select) — meshes + point clouds.

  Hold `Ctrl` (or `⌘` on macOS) and drag with the left mouse button
  in the select tool to draw a rectangle. On release, every entity
  (mesh or point cloud) whose pixel falls inside the rect becomes
  the new selection. A teal-dashed SVG outline tracks the drag.

  Implementation:

  - `Picker.pickRect(x0, y0, x1, y1, …) → Set<expressId>` renders the
    same pick pass as `pick()` and reads back the texel rect, deduping
    hits to a Set. Mesh + point splats both participate (point splats
    share the depth buffer in the pick pass).
  - A new private `Picker.renderPickPass` extracts the shared render-
    pass setup so single-pixel `pick` and rect `pickRect` don't drift.
  - `PickingManager.pickRect` applies the same visibility filtering
    (`hiddenIds`, `isolatedIds`) as `pick`. The CPU-raycast and
    dynamic-mesh-creation fallbacks `pick` uses for very large batched
    models are skipped — rect pick only sees already-hydrated meshes.
  - `Renderer.pickRect` exposes the manager's API.
  - New `RectSelectionOverlay` component renders the dashed SVG box
    while dragging; lives inside `Viewport.tsx` as a sibling of the
    canvas.
  - `useMouseControls` tracks a new `mouseState.isRectSelecting` flag,
    suppresses orbit/pan during the drag, and on mouseup runs
    `renderer.pickRect(...)` and feeds the result into
    `setSelectedEntityIds`. A 4-pixel minimum rect size avoids
    clobbering selection on a stray Ctrl-click.
  - `MouseState.isRectSelecting?: boolean` and a new
    `setRectSelection?` callback added to `UseMouseControlsParams`.

  Lasso (polygonal) pick still pending — covered by issue #611's
  mid-term list. Per-class isolation for points is a separate
  follow-up.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Section-plane drag preview — render at 1/4 density during slider
  drag for responsive section-cutting on huge point clouds.

  The splat shader gains a `previewStride` uniform that culls
  `(instance_index % stride) != 0` at the start of `vs_main`. The
  section-plane position slider wires `onPointerDown` to set
  `previewStride: 4` and `onPointerUp` to restore `1`, so scans of
  millions of points stay responsive while the user drags.

  Implementation:

  - `POINT_UNIFORM_SIZE` bumped from 208 → 224 to add a new
    `extras: vec4<u32>` slot. `extras.x` carries `previewStride`;
    `yzw` reserved for future per-frame state.
  - `PointCloudRenderOptions.previewStride?: number` clamped to
    [1, 256] in the renderer.
  - Vertex shader culls hidden instances by writing
    `clipPos = vec4(0, 0, -2, 1)` (outside reverse-Z `[0, 1]`) so they
    drop pre-rasterisation.
  - New `pointCloudPreviewStride` field on the point cloud slice
    (default 1) with `setPointCloudPreviewStride` action.
  - `usePointCloudSync` forwards the stride to
    `setPointCloudOptions`.
  - `SectionOverlay`'s position slider triggers stride 4 on
    drag start (pointer + keyboard), 1 on release. Only flips when
    `pointCloudAssetCount > 0` so IFC-only sessions are unaffected.

  Triangle meshes ignore the stride — they're cheap enough that
  section drag was already smooth.

  Verified: full repo typecheck (24/24), 655 viewer tests, viewer
  Vite build green.

### Patch Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - E57 ScaledInteger codec — bit-packed cartesian / intensity / colour.

  ScaledInteger is the more compact encoding most real-world Faro,
  Trimble, and Leica E57 exports use; previously we threw a clear
  error on these files. This change implements the decoder so they
  load directly.

  Per spec ASTM E2807-11 §6.3.4:

  - `bitsPerRecord = ceil(log2(maximum - minimum + 1))`
  - Bytestream stores `raw_int = original − minimum` packed LSB-first
    within each byte; decoded float = `(raw_int + minimum) * scale + offset`

  Implementation:

  - New `readBitsLE(bytes, bitOffset, bitsPerRecord)` walks a byte
    buffer and reconstructs each value into a JS number using
    `Math.pow(2, n)` instead of `<< n`, so precision holds up to 53
    bits (covers every real exporter — LiDAR + survey kit tops out
    around 32 bits). Wider fields throw a clear error.
  - `readCartesianStream` and `readIntensityStream` now branch on
    field kind: Float / Integer paths unchanged, ScaledInteger path
    bit-walks per record.
  - `writeColorChannel` extended with a ScaledInteger branch that
    remaps `raw → [0, 1]` via the declared min/max range.
  - Per-axis packet capacity computation now varies by field kind
    (Float = `length / byteSize`, ScaledInteger = `length * 8 / bitsPerRecord`)
    via `floatOrSiPointCapacity`.

  The "ScaledInteger throws clearly" error is removed for cartesian,
  intensity, and colour — all three now decode. The earlier multi-scan
  pose rejection stays in place; that's a separate piece of work.

  2 new tests:

  - 8-bit ScaledInteger across all three cartesian axes (round-trip
    through known raw values).
  - 12-bit ScaledInteger that crosses byte boundaries (proves the
    bit-pack walk is correct for non-multiples-of-8).

  Verified: 63 pointcloud unit tests pass, full repo typecheck (24/24),
  viewer Vite build green.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Near-term batch — correctness + robustness items from #611.

  **`computeBBox` empty / non-finite guards.** Both `e57.ts` and
  `ifcx-points.ts` now return `{0,0,0}/{0,0,0}` for empty arrays and
  skip non-finite triplets. Previously a zero-point or NaN-poisoned
  chunk produced ±Infinity bounds that broke camera fit-to-view and
  section-plane sliders.

  **Magic-byte-first format detection.** `detectPointCloudFormat` now
  probes the buffer (E57 magic, LASF magic, "ply" / "#" / ".PCD"
  ASCII tokens) before falling back to extension. A LAS file
  mistakenly named `*.ply` no longer goes down the wrong decoder. LAS
  vs LAZ still uses the extension to disambiguate (they share the
  LASF magic).

  **E57 packet-bounds + per-stream guards.** Validate that the
  DataPacket header, bytestream-length table, and each individual
  bytestream stay inside `payloadEnd = packetEnd - 4` before reading.
  Corrupt files now fail with a precise "bytestream X runs past
  packet payload" error instead of silently reading into the next
  packet.

  **`e57.ts` split (631 → 4 files).** `e57-page.ts` (header / page CRC
  / section-header resolver), `e57-xml.ts` (prototype + Data3D
  parser), `e57-decode.ts` (per-scan binary decoder), `e57.ts`
  (orchestrator + re-exports). All four under the AGENTS ~400-line
  guideline.

  **`point-cloud-renderer.ts` extract.** Pulled the uniform-block
  writer into `point-cloud-uniforms.ts` (`writePointCloudUniforms` +
  mode index maps). Renderer drops below 400 lines.

  Verified: 62 pointcloud unit tests pass, full repo typecheck
  (24/24).

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`2334993`](https://github.com/louistrue/ifc-lite/commit/2334993827839b9f5b96ca8008c49543fb597660), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/geometry@1.18.0

## 1.18.0

### Minor Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - GPU-based point picking, federation-aware.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phase 0 of full point cloud loading: render the buildingSMART IFCx
  pointcloud samples (`pcd::base64`, `points::array`, `points::base64`).

  - New `@ifc-lite/pointcloud` package: renderer-agnostic decoders for PCD
    (ASCII / binary / binary_compressed via inline LZF) and the two inline
    IFCx point schemas. Pure TS, no three.js, no WebGPU.
  - `@ifc-lite/geometry` adds `PointCloudAsset` and `GeometryResult.pointClouds`.
  - `@ifc-lite/ifcx` adds `extractPointClouds()` and surfaces decoded scans
    on `IfcxParseResult.pointClouds`. The mesh extractor is unchanged.
  - `@ifc-lite/parser` re-exports the new `PointCloudExtraction` type.
  - `@ifc-lite/renderer` gains a WGSL `topology: 'point-list'` pipeline,
    per-asset GPU buffers, and `Renderer.setPointClouds()` /
    `Renderer.addPointClouds()`. Points share the depth buffer and section
    plane state with the triangle pipeline.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phases 1–4 of point cloud loading.

  - **LAS streaming** (`.las` files) — header parser + per-point record decoder
    for ASPRS Point Data Formats 0–10, with auto-detection of "8-bit RGB
    in u16 channels" producers and on-the-fly rescaling.
  - **LAZ streaming** (`.laz` files) — wraps `laz-perf` (Apache-2.0) as a
    runtime dep, decoded inside a Web Worker so the main thread stays
    responsive.
  - **Streaming pipeline** — Blob-backed byte source, decode worker with a
    postMessage protocol that ships chunks back as transferable typed-array
    buffers, host-side controller that paces decode, applies a 25M-point
    memory cap with stride downsampling, and reports progress / completion.
  - **Renderer streaming API** — `Renderer.beginPointCloudStream`,
    `appendPointCloudChunk`, `endPointCloudStream`, `removePointCloudAsset`,
    `setPointCloudOptions`. Streamed assets coexist with IFCx-derived
    assets in separate ownership buckets so `setPointClouds` doesn't clobber
    active streams.
  - **Color modes** — `rgb` / `classification` (ASPRS palette) / `intensity` /
    `height` (cool-warm ramp) / `fixed`. Per-point classification + intensity
    travel through the GPU vertex layout and the WGSL shader picks the
    channel based on the active mode uniform.
  - **Viewer integration** — file picker accepts `.las,.laz` (browser drop +
    native dialog), a small bottom-left panel exposes the color modes when
    point clouds are loaded, and the federation registry's `modelIndex`
    flows through streaming ingest for multi-model picking parity.

  GPU-based point picking is deferred to a follow-up; clicks on points
  return null and don't crash existing mesh selection.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Point cloud rendering quality: splat pipeline + Eye-Dome Lighting.

  The 1-pixel `point-list` rendering looked great from far away but turned
  into a halftone screen as you zoomed in — `point-list` topology has no
  `gl_PointSize` equivalent in WebGPU, so density was fixed in screen space.

  This swaps the pipeline for instanced 6-vertex quad splats and adds a
  post-pass EDL for depth perception.

  **Splat pipeline**

  - `topology: 'triangle-list'`, vertex buffer `stepMode: 'instance'`,
    6 verts emitted per source point. Vertex shader picks a corner from
    `vertex_index` and inflates clip-space position by the active size.
  - Three size modes:
    - `fixed-px` — every splat is N pixels (1..20)
    - `adaptive-world` — splat covers a world-space radius, projected each
      frame; closer = bigger
    - `attenuated` (default) — adaptive but clamped to [1, N] px so splats
      stay visible at far plane and don't blow up to half the screen up close
  - Round shape: fragment discards corners outside the unit disc, so splats
    render as discs not squares.

  **Eye-Dome Lighting**

  - New `EdlPass` runs after the existing PostProcessor. Samples 4 (low) or
    8 (high) neighbouring depths at radius R px, computes mean log-depth-
    diff, darkens by `1 - exp(-300 * meanLog * strength)`. ~9 texture taps
    per pixel. Only active when point clouds are loaded.
  - Reverse-Z aware (`max(0, log(centre) - log(neighbour))`), early-out at
    the far plane.

  **UI**

  - `PointCloudPanel` gains size-mode buttons, a 1–20 px slider, a 1–100 mm
    world-radius slider (visible in adaptive/attenuated modes), and an EDL
    toggle with a 0–3 strength slider.
  - New `pointCloudSlice` fields: `pointCloudSizeMode`, `pointCloudPointSize`,
    `pointCloudWorldRadius`, `pointCloudRoundShape`, `pointCloudEdlEnabled`,
    `pointCloudEdlStrength`. Slice clamps numeric ranges.

  Renderer API additions: `setEdlOptions({enabled, strength, radiusPx,
highQuality})`. `setPointCloudOptions` now also accepts `sizeMode`,
  `worldRadius`, `roundShape`.

### Patch Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 3 of point cloud fixes — correctness gaps that block multi-model
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

  - `onCountChange(-1)` before re-throwing.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Address CodeRabbit + Codex review feedback on PR #608.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit review fixes — correctness + robustness.

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

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/geometry@1.17.0

## 1.17.0

### Minor Changes

- [#597](https://github.com/louistrue/ifc-lite/pull/597) [`370e084`](https://github.com/louistrue/ifc-lite/commit/370e084e94e8fce930bddf948344c4b639d196f3) Thanks [@joepaddock-uk](https://github.com/joepaddock-uk)! - Add `transparencyOverrides?: Map<expressId, alpha>` to `RenderOptions` for
  per-frame alpha control (X-Ray mode).

  Non-selected meshes/batches whose `expressId` appears in the map render at the
  override alpha through the existing transparent pipeline. Selected meshes are
  exempt so highlight rendering stays opaque. Mixed batches (some entries
  overridden, some not) take the minimum override alpha — the selection
  highlight pass then re-renders selected meshes opaque on top, so the user sees
  selection in full while the rest fades.

  Use case: viewers that want a true see-through "X-Ray" effect (selection visible
  through ghosted geometry) instead of fully hiding non-selected elements via
  `isolatedIds`.

  Per-batch alpha resolution walks `batch.expressIds` per frame. For typical batch
  sizes the cost is well below noise vs. the GPU work, and callers supply a fresh
  Map when contents change (same convention as `hiddenIds`/`isolatedIds`). Routing
  is purely per-frame — no mutation of `batch.color`, so IFC-declared alpha baked
  into cached batches stays untouched.

  Also fixes a correctness bug in partial sub-batch pipeline selection: when
  X-Ray + hide/isolate combine, the pipeline now uses the resolved override alpha
  (via `alphaForBatch`) instead of the parent batch's original `color[3]`, ensuring
  transparent overrides route through the transparent pipeline with proper blending.

### Patch Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add the `bim.store.*` namespace — high-level editing of an already-parsed
  `IfcDataStore` via the existing mutation overlay. Closes the merge-roundtrip
  gap from #592 (you can edit `IfcRectangleProfileDef.XDim` or drop a fresh
  `IfcColumn` into a model without round-tripping through a script + re-parse).

  **`@ifc-lite/mutations`** — new `StoreEditor` facade plus four
  `MutablePropertyView` extensions: positional-attribute mutations, overlay
  entity creation/deletion (with watermark seeding), and three helpers used by
  the viewer's undo/redo (`removePositionalMutation`, `restoreFromTombstone`,
  `restoreNewEntity`).

  **`@ifc-lite/create`** — new `in-store/` module: `addColumnToStore` builds a
  12-entity IfcColumn sub-graph (placement, profile, extruded solid,
  representation, product shape, rel-contained-in-spatial-structure) anchored
  to a target `IfcBuildingStorey`. `resolveSpatialAnchor` walks the parsed
  store to find the IfcOwnerHistory, the 'Body' representation context, and
  the storey's local placement.

  **`@ifc-lite/sdk`** — new `StoreNamespace` exposed as `bim.store` on
  `BimContext`. Methods: `addEntity`, `removeEntity`, `setPositionalAttribute`,
  `addColumn`. Backed by `StoreBackendMethods` on `BimBackend`; the
  `RemoteBackend` proxy round-trips them through the transport.

  **`@ifc-lite/sandbox`** — `bim.store.*` is bridged into the QuickJS sandbox
  with full TypeScript types via `bim-globals.d.ts` and an LLM cheat sheet in
  the system prompt. Gated on a new `store: true` permission (default
  `false`, mirrors the existing `mutate` permission pattern).

  **`@ifc-lite/cli`** — `HeadlessBackend.store` is now functional (was a
  no-op before). Scripts run via the CLI can edit a parsed model and export it
  with mutations applied.

  **`@ifc-lite/viewer`** — three new UI surfaces:

  - Raw STEP tab in `PropertiesPanel` — lists every positional STEP argument
    with an inline pen-icon editor for scalar values (numbers, refs, enums,
    null). Mutated rows show a purple dot and tinted background.
  - `EntityContextMenu` gains "Delete entity" (red, calls `removeEntity`
    with toast + undo support) and "Add column here…" (emerald, only enabled
    when the right-clicked entity is an `IfcBuildingStorey`).
  - `AddColumnDialog` modal — storey picker sorted by elevation, position
    (storey-local metres), cross-section, height, name, optional collapsible
    for Description/ObjectType/Tag. Anchor-resolution failures surface
    inline, not as thrown exceptions.

  Plus four new actions on `mutationSlice` (`setPositionalAttribute`,
  `removeEntity`, `addColumn`, dialog open/close) backed by per-model
  `StoreEditor` caches, with undo/redo wired for `UPDATE_POSITIONAL_ATTRIBUTE`,
  `CREATE_ENTITY`, and `DELETE_ENTITY`.

  **`@ifc-lite/parser`** — `package.json` `exports` re-ordered to put `types`
  before `import` so downstream consumers using TS5 `nodenext` resolution
  pick up the type declarations.

  **`@ifc-lite/geometry`** — re-exports `MetadataBootstrapEntitySummary` and
  `MetadataBootstrapSpatialNode` from the package index (used by viewer
  desktop services).

  **`@ifc-lite/renderer`** — `GPUBufferDescriptor` ambient declaration gains
  `mappedAtCreation?: boolean`. Internal change; the renderer was already
  using it at runtime to skip a Mojo IPC round-trip on Chrome/Dawn.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Support real alpha-blended colour overlays so 4D phase tints composite
  over the underlying material instead of replacing it. Previously the
  overlay pipeline only respected the RGB channels; alpha below 1.0 produced
  muddy opaque colour. With this change the overlay path honours per-entity
  alpha + skips the glass-fresnel branch, so the 4D animator's preparation
  ghost and palette-intensity slider render as proper translucent tints.
- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/geometry@1.16.6
  - @ifc-lite/wasm@1.16.7

## 1.16.0

### Minor Changes

- [#561](https://github.com/louistrue/ifc-lite/pull/561) [`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805) Thanks [@louistrue](https://github.com/louistrue)! - 3D section cap with screen-space hatches, driven by exact cut polygons.

  ### `@ifc-lite/renderer`

  - **3D cut surface (cap) rendering.** `Section2DOverlayRenderer` gained
    a fill pipeline that paints the user's cap style on top of the exact
    polygons `SectionCutter` produces from triangle-plane intersection.
    Eight built-in screen-space hatch patterns are supplied via the new
    `section-cap-style.ts` module: `solid`, `diagonal`, `crossHatch`,
    `horizontal`, `vertical`, `concrete` (clean dot grid, ISO 128-50),
    `brick`, `insulation`. Pattern ids match the numeric branches in the
    fill fragment shader and are pinned by unit tests so changes can't
    drift silently. New `Section2DOverlayCapStyle` shape carries fill,
    stroke, pattern id, spacing/angle/width, and a secondary cross-hatch
    angle.
  - **Outline + fill toggle independently.** `Section2DOverlayOptions`
    has new `showFills` and `showOutlines` booleans, both honoured by
    `Section2DOverlayRenderer.draw()`, so callers can hide the cut hatch
    without losing the line drawing or vice versa.
  - **Cap respects model depth.** Both fill and outline pipelines test
    with `depthCompare: 'greater-equal'` (reverse-Z) and don't write
    depth, so when the camera looks through closer model geometry the
    cap is occluded naturally. Cap polygons live exactly on the plane,
    so equal-depth ties tie cleanly with greater-equal.
  - **Cap fill landed exactly on the plane.** Removed the old 0.3 m
    vertical bias that made the hatch visibly drift off the slider
    position; the fill now sits on the cut surface itself.
  - **Depth format unified at `depth24plus-stencil8`.** Main, instanced,
    section-plane preview, and 2D overlay pipelines all declare the same
    depth/stencil format and route through `PIPELINE_CONSTANTS.DEPTH_FORMAT`
    so the literal lives in exactly one place. All in-pass pipelines also
    declare both colour attachments (main colour + objectId, the latter
    with `writeMask: 0`) so WebGPU validation passes regardless of which
    shaders render inside the section render pass.
  - **`flipped` flag plumbed end-to-end.** Main and instanced fragment
    shaders pack `enabled` (bit 0) + `flipped` (bit 1) into one flag slot
    and negate the keep side when flipped — slider position stays where
    it is, only the kept half swaps.
  - **`SectionCapStyle`, `HatchPatternId`, `DEFAULT_CAP_STYLE`, and
    `HATCH_PATTERN_IDS` exported from the package** as the canonical
    styling primitives consumed by the viewer store and the fill shader.
  - **Renderer log on first section enable** (`[Section] Y-up bounds
used for clip: …`) so a user can verify the slider range matches
    their geometry without opening a debugger.

  ### `@ifc-lite/drawing-2d`

  - **Plane equation no longer changes when `flipped`.** Both
    `SectionCutter` and `gpu-section-cutter` now build the plane normal
    from `getAxisNormal(axis, false)` regardless of the flipped flag.
    Previously the flipped normal was paired with an unchanged
    `planeDistance`, which described a different plane (`y = -position`
    instead of `y = position`) — the cutter then looked for intersections
    far outside the model and produced an empty 2D drawing. `flipped` is
    still honoured by `projectTo2D` so the resulting drawing mirrors
    correctly when viewed from the opposite side.

  ### `viewer`

  - **`SectionCapControls` panel.** New compact controls inside the
    expanded Section panel: independent Display toggles for _Surfaces_
    (cap fill) and _Lines_ (outline), hatch pattern dropdown, fill +
    stroke colour pickers, and Spacing / Angle / Width number inputs in
    a 3-col grid. The hatch fieldset disables itself when Surfaces are
    off so users can't tweak settings that don't apply. Every control
    has an explicit `id`/`htmlFor` association via `useId()` for
    assistive tech.
  - **Flip button reflects state.** Now toggles `variant` to `default`,
    carries `aria-pressed`, and swaps `aria-label`/`title` between
    "Flip cut direction" and "Unflip cut direction".
  - **Auto-enable on slider/axis change.** Moving the position slider or
    picking a direction now sets `enabled: true` so users no longer get
    stuck in a no-op "preview mode" wondering why nothing cuts. The
    bottom toggle relabelled "Clip on/off" instead of the old
    "Cutting/Preview" wording that read as if the cut was always live.
  - **2D panel auto-fits on Flip.** `useViewControls` now triggers
    `fitToView` on `sectionPlane.flipped` change as well as axis change,
    so flipping doesn't park the polygons off-screen and leave the
    panel blank.
  - **Cap style persists across reloads.** `showCap`, `showOutlines`,
    and the full `capStyle` (fill, stroke, pattern, spacing, angle,
    width, secondary angle) round-trip to `localStorage` under the keys
    `ifc-lite:section-cap-show`, `ifc-lite:section-outlines-show`, and
    `ifc-lite:section-cap-style`. `resetSectionPlane()` clears them so
    the default button actually resets. `resetViewerState()` (called on
    every IFC load) preserves persisted cap settings and only clears
    axis/position/enabled/flipped — so opening a new file no longer
    wipes the user's hatch and colour choices.
  - **Cap style types deduplicated.** `SectionCapHatchId` and
    `SectionCapStyle` in the viewer store are now re-exports of the
    renderer's `section-cap-style.ts`, so adding a new pattern only
    requires editing the renderer.
  - **localStorage failures are diagnosable.** Every persistence catch
    in `sectionSlice` now logs via `console.warn` instead of a bare
    `catch {}` — quota / private-mode / serialisation failures still
    fall back gracefully but show up in devtools.

### Patch Changes

- Updated dependencies [[`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1)]:
  - @ifc-lite/wasm@1.16.5

## 1.15.3

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 1.15.2

### Patch Changes

- [#531](https://github.com/louistrue/ifc-lite/pull/531) [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e) Thanks [@louistrue](https://github.com/louistrue)! - Fix WGSL shader compilation failure on some GPUs and improve Chrome streaming performance

  - Move dpdx/dpdy calls outside non-uniform control flow to fix shader validation errors on Chrome/Windows GPUs (e.g. RTX 4070)
  - Use mappedAtCreation for vertex/index buffer uploads, eliminating redundant writeBuffer IPC round-trips on Chrome's Dawn backend
  - Increase streaming chunk size from 128 to 512 meshes per append to reduce GPU buffer allocation rounds
  - Remove noisy FederationRegistry "Unknown model" console warnings during single-model loading

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b)]:
  - @ifc-lite/geometry@1.16.5
  - @ifc-lite/wasm@1.16.4

## 1.15.1

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Fix robust flat normal computation, per-entity raycast and selection highlighting for color-merged meshes, and restore desktop native interaction parity.

- Updated dependencies [[`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc), [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e), [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e), [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc), [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc)]:
  - @ifc-lite/geometry@1.16.4
  - @ifc-lite/wasm@1.16.3

## 1.15.0

### Minor Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Fix tile rendering issues in camera controls and projection handling.

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162), [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b)]:
  - @ifc-lite/geometry@1.16.3
  - @ifc-lite/wasm@1.16.2

## 1.14.9

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix partial batch cache key collision by using unique batch id instead of expressIds

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix diagonal line artifacts on coplanar entity boundaries in separation lines shader

## 1.14.8

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4), [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/wasm@1.16.1
  - @ifc-lite/geometry@1.16.2
  - @ifc-lite/spatial@1.14.5

## 1.14.7

### Patch Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix I-beam profile shading with corrected circular profile detection threshold, two-sided lighting, and winding reversal for mirrored profiles

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/wasm@1.16.0
  - @ifc-lite/geometry@1.16.0

## 1.14.6

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix camera pan direction to match intuitive mouse movement.

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515), [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd), [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/geometry@1.14.4
  - @ifc-lite/spatial@1.14.4
  - @ifc-lite/wasm@1.14.5

## 1.14.5

### Patch Changes

- [#402](https://github.com/louistrue/ifc-lite/pull/402) [`48af93b`](https://github.com/louistrue/ifc-lite/commit/48af93b30b08fefb24997edf26c0898d9beb2d1d) Thanks [@louistrue](https://github.com/louistrue)! - Fix external pivot orbit: use Rodrigues axis-angle rotation (Blender-style turntable) instead of independent spherical-coord clamping. Fixes inverted vertical direction, getting stuck at poles, and model flip when look direction approaches vertical. Adds clampLookVertical to prevent view matrix degeneracy while still allowing views from 89.4° above or below.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Remove all zoom restrictions and implement dolly-zoom for unrestricted scene traversal. Zoom now splits each step between distance reduction and forward travel, preventing the Zeno's paradox effect where the camera asymptotically approaches the target but never passes it. Refactor camera-controls to extract vec3/spherical helpers, eliminate duplicated orbit math, and use named constants.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Orbit now pivots around the 3D point under the cursor. At the start of every orbit drag (mouse or touch), a raycast determines what the user is looking at and uses that as the rotation center. If the cursor is over empty space, falls back to the camera target. Removes the old selection-based orbit center which was less intuitive.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Rework walk mode: arrow keys and WASD now move on a fixed horizontal plane with scene-proportional speed and smooth acceleration (velocity lerping). Shift-to-sprint doubles movement speed. Mouse drag in walk mode does full orbit (look around) instead of partial orbit + zoom. Remove orbit and pan tools from toolbar — orbit is the default mouse behavior and pan is accessible via middle/right-click.

## 1.14.4

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/wasm@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: prevent 3D background turning black when toggling spaces/openings/site visibility

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: eliminate facade flickering during orbit and zoom

  - Restore object-ID pass and post-processing during camera interaction (reverts interaction skip that caused visual pop-in)
  - Add PLANE_EPSILON margin to frustum culling plane checks to prevent floating-point jitter from toggling batch visibility at frustum boundaries
  - Skip fresnel glass effects on selected objects so blue highlight renders correctly instead of appearing white

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: eliminate z-fighting flicker on coplanar faces

  - Upgrade depth buffer from depth24plus to depth32float across all pipelines for optimal precision with reverse-Z
  - Add per-entity deterministic depth nudge in vertex shaders using Knuth multiplicative hash to prevent coplanar face flicker
  - Refactor depthFormat into InstancedRenderPipeline member to eliminate hardcoded literals

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - perf: optimize rendering with buffer pooling and frustum culling

  - Add pooled per-frame uniform scratch buffers to eliminate GC pressure from per-batch Float32Array allocations
  - Add frustum culling for batched meshes to skip entire batches outside camera view
  - Build uniform template once per frame with only per-batch color patched, reducing redundant writes
  - Skip post-processing (contact shading, separation lines) during rapid camera interaction for faster frame times

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Minor Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Fix GPU buffer overflow on large models and optimize streaming performance

  - Automatically split color-grouped batches into sub-batches that fit within WebGPU's maxBufferSize limit, preventing createBuffer() failures on large IFC models (1+ GB with 10M+ elements)
  - Introduce lightweight fragment batches during streaming to eliminate O(N²) rebuild cost — fragments render immediately and are merged into final batches on stream completion

### Patch Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Fix mesh batching to handle in-place color mutations during streaming

  Color array references could be reused and mutated in-place between streaming batches, causing incorrect vertex colors when geometry was merged. The fix clones color data at accumulation time to prevent cross-batch contamination.

- Updated dependencies []:
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Minor Changes

- [#220](https://github.com/louistrue/ifc-lite/pull/220) [`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d) Thanks [@louistrue](https://github.com/louistrue)! - Add basket presentation system with saved views, smart input sources, and presentation dock UI. The basket (pinboard) now supports saving named views with camera viewpoints, section plane state, and canvas thumbnails. Smart input resolution automatically picks the best source (selection, hierarchy, or visible scene) for basket operations. A new floating presentation dock provides set/add/remove controls and a scrollable strip of saved views for rapid scene navigation.

### Patch Changes

- [#232](https://github.com/louistrue/ifc-lite/pull/232) [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f) Thanks [@louistrue](https://github.com/louistrue)! - Fix window rendering and interaction regressions for multi-part tessellated elements. The WASM geometry pipeline now correctly triangulates `IfcIndexedPolygonalFaceWithVoids` (including inner loops) and respects optional `PnIndex` remapping, restoring correct window cutouts and subelement colors. Renderer picking, CPU raycasting, and selected-mesh lazy creation now handle all submesh pieces per element/model instead of collapsing to a single piece, and selected highlights are rendered after transparent passes so glass receives the same selection highlight as frames.

- Updated dependencies [[`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Minor Changes

- [#203](https://github.com/louistrue/ifc-lite/pull/203) [`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8) Thanks [@louistrue](https://github.com/louistrue)! - Add visual enhancement post-processing (contact shading, separation lines, edge contrast) and fix geometry parsing / entity type resolution

  **Renderer — visual enhancements:**

  - Add fullscreen post-processing pass (`PostProcessor`) with depth-based contact shading and object-ID-based separation lines for improved visual clarity between adjacent elements
  - Add configurable edge contrast enhancement via shader uniforms with adjustable intensity
  - New `VisualEnhancementOptions` API with independent quality presets (`off` / `low` / `high`), intensity, and radius for contact shading, separation lines, and edge contrast
  - Automatically disable expensive effects on mobile devices

  **Renderer — render pipeline changes:**

  - Add second render target (`rgba8unorm` object ID texture) to all render pipelines (opaque, transparent, overlay, instanced) for per-entity boundary detection
  - Expand vertex format from 6 to 7 floats (position + normal + entityId) across all pipelines and the picker
  - Encode entity IDs into the object ID texture via 24-bit RGB encoding in fragment shaders
  - Depth texture now created with `TEXTURE_BINDING` usage for post-processor sampling
  - Edge contrast rendering made conditional via uniform flags (`flags.z` / `flags.w`) instead of always-on

  **Renderer — geometry & scene:**

  - `GeometryManager` interleaves entity ID into the 7th float of each vertex buffer
  - `Scene` batching writes entity IDs per-vertex into merged buffers for instanced rendering

  **Data — entity type system expansion:**

  - Add ~30 new `IfcTypeEnum` entries: chimney, shading device, building element part, element assembly, reinforcing bar/mesh/tendon, discrete accessory, mechanical fastener, flow controller/moving device/storage device/treatment device/energy conversion device, duct/pipe/cable segments, furniture, proxy, annotation, transport element, civil element, geographic element
  - Add ~11 new type definition enums: pile type, member type, plate type, footing type, covering type, railing type, stair type, ramp type, roof type, curtain wall type, building element proxy type
  - Map `*StandardCase` variants (e.g. `IFCSLABSTANDARDCASE`, `IFCCOLUMNSTANDARDCASE`) to their base enum values for correct grouping
  - Expand `TYPE_STRING_TO_ENUM` and `TYPE_ENUM_TO_STRING` maps with all new types
  - Add new `ifc-entity-names.ts` with 888-line UPPERCASE → PascalCase lookup table (all IFC4X3 entity names) for correct display of any IFC entity type
  - Add `rawTypeName` field to `EntityTableBuilder` storing normalized type name as string index
  - `getTypeName()` now falls back to `rawTypeName` for types not in the enum, eliminating "Unknown" display for valid IFC types

  **Parser:**

  - Add diagnostic `console.debug` logging for spatial entity extraction and `console.warn` on extraction failures

  **WASM / Rust geometry engine:**

  - Replace overly broad geometry entity filter (`starts_with("IFC") && !ends_with("TYPE") && ...`) with explicit whitelist of ~120 IfcProduct subtypes in `has_geometry_by_name`, preventing non-product entities (e.g. `IfcDimensionalExponents`, `IfcSurfaceStyleRendering`) from being sent to geometry processing
  - Add `SolidModel` to the accepted representation types in the geometry router (6 match arms)
  - Use smooth per-vertex normals for extruded circular profiles (cylinder side walls) with `is_approximately_circular_profile` heuristic that detects circular vs polygonal profiles by coefficient of variation of radii from centroid
  - Increase circle tessellation from 24 to 36 segments for profiles (circle, circle hollow, trimmed curve, ellipse)
  - Increase swept disk solid tube segments from 12 to 24 for smoother pipes
  - Fix `PolygonalFaceSet` processing: generate flat-shaded meshes with per-face normals via `build_flat_shaded_mesh` and fix closed-shell winding orientation via `orient_closed_shell_outward`
  - Improve geometry extraction statistics: separate "no representation" (expected) from actual processing failures in diagnostic logging
  - Add `console.debug` logging for entities skipped due to missing representation

  **Viewer app:**

  - Add visual enhancement state to Zustand UI slice with 10 configurable properties (enabled, edge contrast enabled/intensity, contact shading quality/intensity/radius, separation lines enabled/quality/intensity/radius)
  - Wire `VisualEnhancementOptions` through `Viewport`, `useAnimationLoop`, and `useRenderUpdates` via memoized ref pattern
  - Show IFC type name instead of "Unknown" for spatial entities with generic names in the tree hierarchy
  - Expand `useThemeState` hook with all visual enhancement selectors

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/wasm@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/spatial@1.9.0
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Minor Changes

- [#213](https://github.com/louistrue/ifc-lite/pull/213) [`7ae9711`](https://github.com/louistrue/ifc-lite/commit/7ae971119ad92c05c521a4931105a9a977ffc667) Thanks [@louistrue](https://github.com/louistrue)! - Add basket-based multi-isolation with incremental add/remove

  - Basket isolation system: build an isolation set incrementally with `=` (set), `+` (add), `−` (remove) via keyboard, toolbar, or context menu
  - Cmd/Ctrl+Click multi-select feeds directly into basket operations — select multiple entities, then press `+` to add them all
  - Spacebar as additional shortcut to hide selected entity (alongside Delete/Backspace)
  - Escape now clears basket along with selection and filters
  - Toolbar shows active basket with entity count badge; context menu exposes Set/Add/Remove actions per entity
  - Unified EntityRef resolution via `resolveEntityRef()` — single source of truth for globalId-to-model mapping across all UI surfaces
  - Fix: Cmd+Click multi-select now works reliably in all model configurations (single-model, multi-model, legacy)

- [#205](https://github.com/louistrue/ifc-lite/pull/205) [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81) Thanks [@louistrue](https://github.com/louistrue)! - Add flexible lens coloring system with GPU overlay rendering

  - Color overlay system: renders lens colors on top of original geometry using depth-equal pipeline, eliminating batch rebuild and framerate drops
  - Auto-color by any IFC data: properties, quantities, classifications, materials, attributes, and class
  - Dynamic discovery of available data from loaded models (lazy on-demand for properties, quantities, classifications, materials)
  - Classification system selector in AutoColorEditor (separates Uniclass/OmniClass)
  - Unlimited unique colors with sortable legend

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/spatial@1.8.0
  - @ifc-lite/wasm@1.8.0

## 1.7.0

### Minor Changes

- [#204](https://github.com/louistrue/ifc-lite/pull/204) [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04) Thanks [@louistrue](https://github.com/louistrue)! - Add orthographic projection, pinboard, lens, type tree, and floorplan views

  ### Renderer

  - Orthographic reverse-Z projection matrix in math utilities
  - Camera projection mode toggle (perspective/orthographic) with seamless switching
  - Orthographic zoom scales view size instead of camera distance
  - Parallel ray unprojection for orthographic picking

  ### Viewer

  - **Orthographic projection**: Toggle button, unified Views dropdown, numpad `5` keyboard shortcut
  - **Automatic Floorplan**: Per-storey section cuts with top-down ortho view, dropdown in toolbar
  - **Pinboard**: Selection basket with Pin/Unpin/Show, entity isolation via serialized EntityRef Set
  - **Tree View by Type**: IFC type grouping mode alongside spatial hierarchy, localStorage persistence
  - **Lens**: Rule-based 3D colorization/filtering with built-in presets (By IFC Type, Structural Elements), full panel UI with color legend and rule evaluation engine

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/spatial@1.7.0
  - @ifc-lite/wasm@1.7.0

## 1.5.0

### Minor Changes

- [#162](https://github.com/louistrue/ifc-lite/pull/162) [`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259) Thanks [@louistrue](https://github.com/louistrue)! - Add symbolic representation support for 2D drawings

  - **New Feature**: Added `parseSymbolicRepresentations` WASM API to extract 2D Plan, Annotation, and FootPrint representations from IFC files
  - **New Feature**: Section2DPanel now supports toggling between section cuts and symbolic representations (architectural floor plans)
  - **New Feature**: Added hybrid mode that combines section cuts with symbolic representations
  - **New Feature**: Building rotation detection from IfcSite placement for proper floor plan orientation
  - **Enhancement**: RTC offset streaming events for better coordinate handling in large models
  - **Enhancement**: Geometry processor now reports building rotation in coordinate info
  - **Types**: Added `SymbolicRepresentationCollection`, `SymbolicPolyline`, `SymbolicCircle` types

### Patch Changes

- Updated dependencies [[`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259)]:
  - @ifc-lite/geometry@1.5.0
  - @ifc-lite/wasm@1.5.0

## 1.4.0

### Patch Changes

- 0191843: feat: Add BCF (BIM Collaboration Format) support

  Adds full BCF 2.1 support for issue tracking and collaboration in BIM workflows:

  **BCF Package (@ifc-lite/bcf):**

  - Read/write BCF 2.1 .bcfzip files
  - Full viewpoint support with camera position, components, and clipping planes
  - Coordinate system conversion between Y-up (viewer) and Z-up (IFC/BCF)
  - Support for multiple snapshot naming conventions
  - IFC GlobalId mapping for component references

  **Viewer Integration:**

  - BCF panel integrated into properties panel area (resizable, same layout)
  - Topic management with filtering and status updates
  - Viewpoint capture with camera state, selection, and snapshot
  - Viewpoint activation with smooth camera animation and visibility state
  - Import/export BCF files compatible with BIMcollab and other tools
  - Email setup nudge in empty state for easy author configuration
  - Smart filename generation using model name for downloads

  **Renderer Fixes:**

  - Fix screenshot distortion caused by WebGPU texture row alignment
  - Add GPU-synchronized screenshot capture for accurate snapshots

  **Parser Fixes:**

  - Extract GlobalIds for all geometry entities (not just spatial) to enable BCF component references

  **Bug Fixes:**

  - Fix BCF viewpoint visibility not clearing isolation mode
  - Add localStorage error handling for private browsing mode
  - Fix BCF XML schema compliance for BIMcollab compatibility:
    - Correct element order (Selection before Visibility)
    - Move ViewSetupHints to Components level (not inside Visibility)
    - Write OriginatingSystem/AuthoringToolId as child elements (not attributes)
    - Always include required Visibility element

- c6a3a95: feat: Add shift+drag orthogonal constraint for measurements

  When in measure mode, holding Shift while dragging constrains measurements to orthogonal axes (X, Y, Z). This enables precise horizontal, vertical, and depth measurements.

  - Visual axis indicators show available constraint directions (red=X, green=Y, blue=Z)
  - Snaps to edges and vertices in orthogonal mode for precision
  - Shift+drag before first point allows camera orbit
  - Adaptive performance optimization for complex models

## 1.3.0

### Patch Changes

- [#117](https://github.com/louistrue/ifc-lite/pull/117) [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490) Thanks [@louistrue](https://github.com/louistrue)! - Fix multi-material rendering and enhance CSG operations

  ### Multi-Material Rendering

  - Windows now correctly render with transparent glass panels and opaque frames
  - Doors now render all submeshes including inner framing with correct colors
  - Fixed mesh deduplication in Viewport that was filtering out submeshes sharing the same expressId
  - Added SubMesh and SubMeshCollection types to track per-geometry-item meshes for style lookup

  ### CSG Operations

  - Added union and intersection mesh operations for full boolean CSG support
  - Improved CSG clipping with degenerate triangle removal to eliminate artifacts
  - Enhanced bounds overlap detection for better performance
  - Added cleanup of triangles inside opening bounds to remove CSG artifacts

- [#130](https://github.com/louistrue/ifc-lite/pull/130) [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 federated loading support with layer composition

  ## Features

  - **Federated IFCX Loading**: Load multiple IFCX files that compose into a unified model

    - Supports the IFC5/IFCX Entity-Component-System architecture
    - Later files in the composition chain override earlier files (USD-inspired semantics)
    - Properties from overlay files merge with base geometry files

  - **Models Panel Integration**: Show all federated layers in the Models panel

    - Each layer (base + overlays) displayed as a separate entry
    - Overlay-only files (no geometry) shown with data indicator
    - Toggle visibility per layer

  - **Add Overlay via "+" Button**: Add IFCX overlay files to existing models
    - Works with both single-file and already-federated IFCX models
    - Automatically re-composes with new overlay as strongest layer
    - Preserves original files for future re-composition

  ## Fixes

  - **Property Panel Layout**: Long property strings no longer push other values off-screen

    - Changed from flexbox to CSS grid layout
    - Individual horizontal scroll on each property value

  - **3D Selection Highlighting**: Fixed race condition that broke highlighting after adding overlays

    - Geometry now comes exclusively from models Map (not legacy state)
    - Meshes correctly tagged with modelIndex for multi-model selection

  - **ID Range Tracking**: Fixed maxExpressId calculation for proper entity resolution
    - resolveGlobalIdFromModels now correctly finds entities across federated layers

  ## Technical Details

  - New `LayerStack` class manages ordered composition with strongest-to-weakest semantics
  - New `PathIndex` class enables efficient cross-layer entity lookups
  - `parseFederatedIfcx` function handles multi-file composition
  - Viewer auto-detects when multiple IFCX files are loaded together

- Updated dependencies [[`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857), [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490), [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e)]:
  - @ifc-lite/wasm@1.3.0
  - @ifc-lite/geometry@1.3.0

## 1.2.1

### Patch Changes

- bd6dccd: Fix section plane activation and clipping behavior.
  - Section plane now only active when Section tool is selected
  - Fixed section plane bounds to use model geometry bounds
  - Simplified section plane axis to x/y/z coordinates
  - Fixed visual section plane rendering with proper depth testing
- bd6dccd: Add magnetic edge snapping to measure tool.
  - New raycastSceneMagnetic API for edge-aware snapping
  - Edge lock state management for "stick and slide" behavior
  - Corner detection with valence tracking
  - Smooth snapping transitions along edges

## 1.2.0

### Minor Changes

- ed8f77b: ### New Features

  - **CPU Raycasting for Picking**: Added CPU raycasting support for picking large models, improving interaction performance for complex scenes

  ### Bug Fixes

  - **Fixed Ray Origin**: Fixed ray origin to use camera position for accurate CPU picking
  - **Fixed Raycasting Logic**: Improved raycasting logic to always use CPU raycasting when batched meshes exist and creation threshold is exceeded

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- f4fbf8c: ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- ed8f77b: ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- f7133a3: ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- b9990c7: ### Bug Fixes

  - **Fixed visibility filtering for merged meshes**: Mesh pieces are now accumulated per expressId, ensuring visibility toggling works correctly when multiple geometry pieces belong to the same IFC element
  - **Fixed spatial structure filtering**: Spatial structure types (IfcSpace, IfcSite, etc.) are now properly filtered from contained elements lists
  - **Fixed spatial hierarchy cache**: Spatial hierarchy is now correctly rebuilt when loading models from cache

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies
- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies [ed8f77b]
- Updated dependencies
- Updated dependencies [f7133a3]
  - @ifc-lite/wasm@1.2.0
  - @ifc-lite/geometry@1.2.0

## 1.2.0

### Minor Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **CPU Raycasting for Picking**: Added CPU raycasting support for picking large models, improving interaction performance for complex scenes

  ### Bug Fixes

  - **Fixed Ray Origin**: Fixed ray origin to use camera position for accurate CPU picking
  - **Fixed Raycasting Logic**: Improved raycasting logic to always use CPU raycasting when batched meshes exist and creation threshold is exceeded

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- [#52](https://github.com/louistrue/ifc-lite/pull/52) [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- [#46](https://github.com/louistrue/ifc-lite/pull/46) [`b9990c7`](https://github.com/louistrue/ifc-lite/commit/b9990c7913c1b8bf25366699dcfd8a1f924b0b45) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed visibility filtering for merged meshes**: Mesh pieces are now accumulated per expressId, ensuring visibility toggling works correctly when multiple geometry pieces belong to the same IFC element
  - **Fixed spatial structure filtering**: Spatial structure types (IfcSpace, IfcSite, etc.) are now properly filtered from contained elements lists
  - **Fixed spatial hierarchy cache**: Spatial hierarchy is now correctly rebuilt when loading models from cache

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- Updated dependencies [[`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff)]:
  - @ifc-lite/wasm@1.2.0
  - @ifc-lite/geometry@1.2.0
