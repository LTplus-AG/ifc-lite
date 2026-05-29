# @ifc-lite/viewer

## 1.25.1

### Patch Changes

- [#839](https://github.com/LTplus-AG/ifc-lite/pull/839) [`8c1632c`](https://github.com/LTplus-AG/ifc-lite/commit/8c1632ceb63ff4cfdbac4f2936d54d2d3a7e2f1b) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC annotation legibility in 3D (issue [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) follow-up):

  - **All annotation text now billboards to the camera.** Previously only
    IfcGridAxis tags rebuilt in the screen-aligned basis; IfcAnnotation
    text (dimensions, leader labels, room tags) kept its authored
    in-plane orientation. In oblique views that text collapsed to a
    smeared sliver of pixels — the "distorted dimension labels in
    FZK-Haus" symptom from the issue. The shader path was already
    per-instance billboard-aware, so the change is just a flag flip at
    upload time; anchor and alignment are unchanged.

  - **Grid bubbles no longer paint a white disc behind the tag.** The
    bubble interior is now transparent, so geometry behind a grid line
    reads through the bubble in 3D. The black outline ring (◯) and tag
    glyph are unchanged — the white ● fill instance has been removed
    from `emit_bubble`, which also drops one text instance per bubble.

  - **Annotation text no longer z-fights coplanar surfaces.** Now that
    every glyph billboards, the quad faces the camera with zero depth
    slope across its screen extent — which means the text pipeline's
    `depthBiasSlopeScale: -0.5` contributes ~0 and only the small `-4`
    constant survives, not enough to beat MSAA jitter on a label drawn
    exactly on a wall/floor face (visible as dimension digits strobing
    against terrain in 3D). The symbolic-overlay text shader now applies
    the same `clip.z + 5e-5 * clip.w` reverse-Z nudge the section-2D
    line pipeline already uses — depth-format-independent, slope-
    independent, and large enough to clear coplanar jitter without
    pulling the label visibly off the surface.

- Updated dependencies [[`8c1632c`](https://github.com/LTplus-AG/ifc-lite/commit/8c1632ceb63ff4cfdbac4f2936d54d2d3a7e2f1b), [`231e494`](https://github.com/LTplus-AG/ifc-lite/commit/231e494e7ee920c5219d7fa5c5c6dde4c2bced2a), [`279d897`](https://github.com/LTplus-AG/ifc-lite/commit/279d897dd6e28214930a6b0fffe01dd813141ee0), [`d83fc42`](https://github.com/LTplus-AG/ifc-lite/commit/d83fc424a6b9d2a786e2dfaabe1dc2fb8746d07c)]:
  - @ifc-lite/renderer@1.22.2
  - @ifc-lite/wasm@1.19.2

## 1.25.0

### Minor Changes

- [#815](https://github.com/LTplus-AG/ifc-lite/pull/815) [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937) Thanks [@louistrue](https://github.com/louistrue)! - Make IFC annotation overlays usable in real drawings (issue [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) follow-up
  to the annotation text feature):

  - **3D z-fight fix**: annotation lines, fills, and text pipelines now apply
    a reverse-Z `depthBias` / `depthBiasSlopeScale` so a label drawn exactly
    on a wall/floor face no longer disappears or strobes. This was the user-
    reported "coplanar glitch" — the per-fragment depth-equal pass plus MSAA
    jitter was the actual cause, not line weight. The pipelines remain
    `depthCompare: 'greater-equal'` so foreground geometry still occludes the
    overlay correctly.

  - **Annotations in 2D section views**: the Section 2D panel now overlays
    IfcAnnotation curves, text, and fills on the section drawing when their
    authored storey elevation falls inside the cut's view-range on the cut
    axis. New `showIfcAnnotations` flag on `drawing2DDisplayOptions` (defaults
    on) and a header toggle (Tag icon, next to Symbolic-vs-Cut) wire it up.
    The toggle is currently active only for floor-plan views (`axis='down'`);
    elevation/section axes need a separate coord-reorientation pass and are
    disabled in the UI.

  The 2D path reuses the existing module-global parse cache from
  `useSymbolicAnnotations`, so the WASM symbolic-representation parse runs
  at most once per loaded model regardless of how many overlay surfaces are
  active.

### Patch Changes

- [#827](https://github.com/LTplus-AG/ifc-lite/pull/827) [`4c87791`](https://github.com/LTplus-AG/ifc-lite/commit/4c87791aa17780ec7d3f007dddf841d5606c5cdc) Thanks [@louistrue](https://github.com/louistrue)! - Address CodeRabbit feedback from PR [#823](https://github.com/LTplus-AG/ifc-lite/issues/823):

  - Auto-populate `modelId` in the Lens rule editor when exactly one federated model is loaded, so the single-model branch (which hides the selector) no longer leaves the rule permanently invalid.
  - Fix a `ReferenceError` in `scripts/fetch-prebuilt-wasm.mjs` by routing both prebuilt-fetch and source-build flows through a shared `scripts/lib/patch-threaded-stub.mjs` helper that imports `writeFileSync` and uses a regex anchored on the default export (resilient to wasm-bindgen formatting changes).
  - Refresh the stale build-command reference in `@ifc-lite/wasm-threaded`'s package description.

  Closes [#824](https://github.com/LTplus-AG/ifc-lite/issues/824).

- Updated dependencies [[`8b48495`](https://github.com/LTplus-AG/ifc-lite/commit/8b48495bc65c8ca778c3b60f271108f641fafe02), [`78f1d10`](https://github.com/LTplus-AG/ifc-lite/commit/78f1d10aab812da682962845638daa95b86ae178), [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937), [`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84), [`a72c8d9`](https://github.com/LTplus-AG/ifc-lite/commit/a72c8d9d71da428cec6453e60c650c6cb296007c), [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3), [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937)]:
  - @ifc-lite/bcf@1.15.4
  - @ifc-lite/cache@1.14.7
  - @ifc-lite/export@1.19.2
  - @ifc-lite/renderer@1.22.1
  - @ifc-lite/wasm@1.19.1
  - @ifc-lite/parser@2.4.2
  - @ifc-lite/lens@1.15.0
  - @ifc-lite/ids@1.15.3

## 1.24.0

### Minor Changes

- [#659](https://github.com/LTplus-AG/ifc-lite/pull/659) [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec) Thanks [@louistrue](https://github.com/louistrue)! - Render IfcAnnotation 2D representations as a 3D drawing-layer overlay
  (closes [#653](https://github.com/LTplus-AG/ifc-lite/issues/653)). Implements the BIMVision-style "model + annotations =
  engineering drawing" effect described by the OP.

  What's covered:

  - **Rust WASM**: new `SymbolicText` and `SymbolicFillArea` types
    carried alongside the existing symbolic polyline output. The parser
    walks `IfcTextLiteralWithExtent.Placement` and
    `IfcAnnotationFillArea.OuterBoundary`/`InnerBoundaries` (across
    `IfcPolyline` and `IfcIndexedPolyCurve`).
  - **TS hook**: `useSymbolicAnnotationsRichData()` returns 3D-lifted
    texts + fills with per-storey resolution. Module-level parse cache
    is now keyed on `byteLength + FNV-1a fingerprints of head/mid/tail`,
    so federated views with same-size IFCs no longer alias each other.
    Storey elevation handling distinguishes "no authored elevation"
    from "elevation = 0.0" (the previous sentinel collapsed both to
    the fallback Y).
  - **Renderer**: two new WebGPU pipelines — `SymbolicFillPipeline`
    (ear-clipping triangulation with rightmost-vertex bridge-edge
    hole stitching, premultiplied-alpha blend) and
    `SymbolicTextPipeline` (Canvas2D glyph atlas → instanced WebGPU
    quads). Both declare matching MSAA sample count + the 2-color-
    target attachment shape used by the main render pass, and run with
    reverse-Z `greater-equal` depth compare so they composite correctly
    against the scene.
  - **Viewport wiring**: `Viewport.tsx` calls the new hook unconditionally
    whenever the user enables the IFC Annotations toggle — no section-
    plane gating, since annotations are a free-floating drawing layer.

  Deferred (no behaviour change, follow-up):

  - `IfcStyledItem` → `IfcFillAreaStyleHatching` resolution. The parser
    stubs in a default opaque dark-grey solid fill; the renderer is
    ready to consume a hatch style once the styled-item index lands.

### Patch Changes

- Updated dependencies [[`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec)]:
  - @ifc-lite/extensions@0.2.0
  - @ifc-lite/renderer@1.22.0
  - @ifc-lite/wasm@1.19.0

## 1.23.0

### Minor Changes

- [#688](https://github.com/LTplus-AG/ifc-lite/pull/688) [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91) Thanks [@louistrue](https://github.com/louistrue)! - Add GLB export dialog with colour-source selection and visibility
  filtering (PR [#688](https://github.com/LTplus-AG/ifc-lite/issues/688)).

  The new `GLBExportDialog` in the viewer replaces the inline GLB
  export handler in `MainToolbar` with a dedicated dialog. Features:

  - **Model picker** for federated multi-model scenes.
  - **Colour source** selector: "Rendering" (the apparent display
    colour — `IfcSurfaceStyleRendering.DiffuseColour` if authored,
    falling back to `IfcSurfaceStyleShading.SurfaceColour`) or
    "Shading" (the raw `SurfaceColour`, only available when the file
    authored a distinct `DiffuseColour`).
  - **Visible-only filter** that respects the viewer's hidden /
    isolated entity sets. Mesh-vs-set comparison runs in global ID
    space so federated models with non-zero `idOffset` filter
    correctly.
  - **Metadata inclusion** toggle for IFC GlobalId / type / name
    side-tables.

  Pipeline changes underneath:

  - `MeshData` / `MeshDataJs` carry an optional `shadingColor`
    alongside `color`. The Rust styling module now extracts both
    `IfcSurfaceStyleRendering.DiffuseColour` (rendering) and
    `IfcSurfaceStyleShading.SurfaceColour` (shading) in a single
    pre-pass and returns them as separate maps; `shadingColor` is
    only populated when it actually differs from the rendering
    colour, so memory cost stays sparse on the common case.
  - The streaming geometry path
    (`convertMeshCollectionToBatch`) and the worker collector
    (`IfcLiteMeshCollector`) both copy `shadingColor` end-to-end so
    the dialog's "Shading" source works on every load path, not just
    the batch path.
  - `GLTFExporter` gains `colorSource`, `visibleOnly`,
    `hiddenEntityIds`, and `isolatedEntityIds` options. Visibility
    filtering compares mesh `expressId` (global) against the dialog-
    supplied sets (also global) — no offset arithmetic in the
    exporter.

### Patch Changes

- Updated dependencies [[`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5), [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5), [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91)]:
  - @ifc-lite/wasm@1.18.0
  - @ifc-lite/export@1.19.0
  - @ifc-lite/geometry@1.19.0

## 1.22.1

### Patch Changes

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix "Add Model to Scene" hiding the first model when a second is
  loaded (issue [#661](https://github.com/LTplus-AG/ifc-lite/issues/661), PR [#792](https://github.com/LTplus-AG/ifc-lite/issues/792)). `useIfcFederation.addModel` always
  called `setIfcDataStore(parsedDataStore)` and
  `setGeometryResult(parsedGeometry)` after `storeAddModel`, with the
  new model's data. `modelSlice.addModel` only flips `activeModelId`
  for the FIRST model, so on subsequent adds those legacy setters
  wrote the new model's data into `models.get(activeModelId)` — i.e.
  into the FIRST model's per-model entry — aliasing both Map entries
  to the second model's mesh and rendering only one element.

  The fix drops those two redundant calls from `addModel`. For the
  first model `modelSlice.addModel` already mirrors the data into the
  top-level fields, and for subsequent models the legacy top-level
  fields must stay pointing at the active (first) model's data; the
  existing `setActiveModel` handler updates them on focus change.

- Updated dependencies [[`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa), [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56), [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56), [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa)]:
  - @ifc-lite/wasm@1.17.0

## 1.22.0

### Minor Changes

- [#686](https://github.com/louistrue/ifc-lite/pull/686) [`b19865c`](https://github.com/louistrue/ifc-lite/commit/b19865cecc1f9c0dc05747d576604578f5af0408) Thanks [@louistrue](https://github.com/louistrue)! - BYOK key entry moves from an inline strip into a trust-focused modal with one tab per provider. Each tab shows an SVG that contrasts the direct browser → provider request path against the "via our server" path we never use, DevTools-verifiable trust claims, a clipboard-detect shortcut (so users who just created a key on the provider console don't have to paste), and a 60-second walkthrough. A small key icon in the chat header reopens the modal for management, and a "🔒 → api.provider.com" pill next to the model name names the actual API host whenever a BYOK route is active.

  Adds two new BYOK model IDs: `claude-opus-4-7` (Anthropic) and `gpt-5.5` (OpenAI). Note that Claude Opus 4.7 and the GPT-5 reasoning family reject classic sampling parameters (`temperature`/`top_p`/`top_k`); a new `acceptsSamplingParams` flag on `LLMModel` lets the direct stream client omit them for affected models.

  Web build: this is the first time API-key entry has a real surface outside the cramped inline strip, since `/settings` is desktop-only.

## 1.21.0

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

### Patch Changes

- Updated dependencies [[`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158)]:
  - @ifc-lite/renderer@1.20.0
  - @ifc-lite/drawing-2d@1.16.0

## 1.20.0

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

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - PTS / XYZ ASCII point cloud reader.

  Both formats are line-oriented plain-text scans common in legacy
  survey workflows. They share the same syntax — they differ only in
  the optional first-line point count (PTS may have one; XYZ never
  does). One shared decoder + streaming source handles both.

  Auto-detected per-line layouts (by column count of the first data
  line):

  - 3 cols → `X Y Z`
  - 4 cols → `X Y Z I` (intensity)
  - 6 cols → `X Y Z R G B`
  - 7 cols → `X Y Z I R G B` (canonical PTS)
  - 9 cols → `X Y Z R G B Nx Ny Nz` (XYZ-with-normals; normals dropped)
  - 10 cols → `X Y Z I R G B Nx Ny Nz` (PTS-with-normals; normals dropped)
  - For XYZ with unknown column counts ≥3 we still emit positions and
    skip the rest, so weird custom exports load instead of erroring.

  Other behaviour:

  - Comment lines (`#`, `//`) and blank lines are skipped.
  - Intensity normalisation: 0..1 vs 0..255 vs raw sensor detected from
    the observed maximum, then mapped to u16.
  - RGB normalisation: same heuristic (>1.0 → 0..255 source).
  - Whole-file decode wrapped in `AsciiPointsStreamingSource`; the
    streaming host's 25M-point cap stride-downsamples on the way out.

  Wired into the decode worker, format detection
  (`detectPointCloudFormat` returns `'pts'` / `'xyz'`), the file
  picker accept lists, drop handlers, and both `useIfcLoader` /
  `useIfcFederation` ingest branches. The "PTS / XYZ ASCII points —
  not yet supported" toast is removed from `describeUnsupportedFormat`.

  10 new unit tests cover layout probing, decoder round-trips for the
  common shapes, and the comment / header-count edge cases.

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

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ load failing with `WebAssembly: Response has unsupported MIME
type 'text/plain'` on real-world files (e.g. autzen-classified.laz).

  `laz-perf`'s emscripten shim resolves the wasm via `locateFile()` and
  calls `fetch("laz-perf.wasm")` relative to its own script directory.
  In a Vite-bundled module worker that path becomes `/assets/<chunk>/…`
  or just `/laz-perf.wasm` — both 404, and the SPA fallback returns
  `index.html` as `text/plain`, which `instantiateStreaming` rightly
  rejects. The async fallback then 404s the same way and aborts.

  `loadLazPerf` now resolves the wasm asset URL through Vite's
  `?url` import (`laz-perf/lib/web/laz-perf.wasm?url`), pre-fetches the
  bytes itself, and hands them to emscripten as `Module.wasmBinary` so
  the shim's own fetch is bypassed entirely. Failure modes (asset
  resolution, fetch HTTP error) now produce a precise error message
  naming the URL and status instead of the opaque emscripten "Aborted".

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

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit feedback on PR #614:

  - **E57 stride downsampling drops classifications.** `applyStride` rebuilt
    positions / colors / intensities into new arrays but never copied the
    per-point class IDs, so any non-default stride (`{ stride: 2 }` and up)
    silently lost them and `hasClassification` flipped to false.
  - **Federation abort can stomp a newer load.** The AbortError handler in
    `useIfcFederation.addModel()` wrote `progress`, `error`, and `loading`
    unconditionally — if a second `addModel()` started after the first was
    cancelled, it lost its spinner and progress to the cancelled load's
    cleanup. Added a `loadSessionRef` token (mirrors `useIfcLoader`) and
    gate state writes on `loadSessionRef.current === currentSession`.
  - **E57 Integer classification subtracts `minimum`.** Class IDs are
    absolute labels (ASPRS LAS 1.4 0..31), not range-normalised offsets.
    `raw - minimum` was corrupting class IDs whenever a producer declared
    a non-zero `minimum` on the Integer-encoded classification field. The
    Integer branch now matches the ScaledInteger branch's intent: keep
    the raw byte, clamp to 0..255.
  - **PCD probe missed `VERSION` / `FIELDS` headers.** The magic-byte
    detector only recognised `# .PCD …` comment-style headers. Real PCDs
    emitted by PCL's `pcl_io` and a few third-party tools start directly
    with `VERSION 0.7\n…` or `FIELDS x y z\n…` — these now route through
    the PCD decoder instead of falling through to extension-based
    detection (which would mis-route a renamed PCD).
  - **Catch-block logging.** Per repo convention, log point-cloud ingest
    failures in `useIfcLoader.ts` before the early return so abort vs.
    real-failure vs. stale-session paths are distinguishable in console
    triage.

  Test cleanup: drop the shadowed (and unused) ScaledInteger packet
  buffer in `e57.test.ts` so only the live `fullBuf` setup remains.

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`2334993`](https://github.com/louistrue/ifc-lite/commit/2334993827839b9f5b96ca8008c49543fb597660), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/geometry@1.18.0
  - @ifc-lite/parser@2.4.0
  - @ifc-lite/data@1.17.0
  - @ifc-lite/renderer@1.19.0
  - @ifc-lite/pointcloud@0.3.0
  - @ifc-lite/ids@1.15.1
  - @ifc-lite/lists@1.14.12

## 1.19.2

### Patch Changes

- [#622](https://github.com/louistrue/ifc-lite/pull/622) [`28db7df`](https://github.com/louistrue/ifc-lite/commit/28db7df0fa64dc8cab0d08f4948fb1d9b67e0f70) Thanks [@louistrue](https://github.com/louistrue)! - Cesium overlay: precomputed terrain placement, ground-floor clamping,
  and a refactored camera path.

  **Placement is now resolved before the bridge is built** (no more
  "model loads at IFC OrthogonalHeight, then jumps to terrain"):

  - `terrain-elevation.ts` (new module) tries sources in fast-first
    order — sync `globe.getHeight`, sync `scene.sampleHeight`, async
    `scene.sampleHeightMostDetailed` with a 3.5 s timeout, then
    Open-Meteo as a bare-earth fallback. Implausible elevations
    (e.g. depth-buffer noise from Google Photorealistic 3D Tiles
    returning `-69184 m`) are range-checked against terrestrial bounds.
    Results are cached per-session via `clearTerrainElevationCache()`.
  - `sampleHeightMostDetailed` runs _before_ Open-Meteo so the model
    lands on the same surface the user actually sees in 3D Tiles
    (street decks, podiums) rather than the bare-earth DEM.
  - `createCesiumBridge` accepts a `placementHeightOverride` so the
    computed placement is baked into the `enuToEcef` origin altitude
    for both camera frame and model matrix from creation.

  **`findClampAnchorY` (new helper, 9 unit tests)** picks the anchor
  viewer-Y that auto-clamp pins to terrain. Primary: the
  `IfcBuildingStorey` whose elevation is closest to 0 (ground floor),
  within the model AABB. Fallback: `bounds.min.y`. Without this,
  basements and foundations dragged the model deep below the terrain
  surface.

  **`oHeightForBaseAltitude`** in the Georeferencing panel now mirrors
  the auto-clamp formula (anchor-aware, shift- and RTC-aware), so the
  "Set OrthogonalHeight to Cesium terrain elevation" button produces
  the same world position as toggling the clamp.

  **UX behaviours**

  - `cesiumTerrainClamp` defaults to `true` (slice + reset path).
  - Clamp toggle is now actually uncheckable — dropped the auto-toggle
    branch that fought the user's setting.
  - Editing OrthogonalHeight directly auto-releases the clamp so the
    edit takes effect (with clamp on, placement is intentionally
    terrain-anchored regardless of OrthogonalHeight).
  - Stale `terrainHeight` / `terrainClipY` are cleared when a re-query
    fails so the clip plane doesn't drift relative to the new bridge.
  - Effect 2d depends on `bridgeVersion` so the model matrix refreshes
    after an async bridge rebuild.

  **Camera navigation refactor.** Reported symptom: orbit/zoom
  restricted to the terrain plane. Two coupled root causes:

  1. `screenSpaceCameraController.enableInputs` was still default-true.
     Any input slipping past the overlay's `pointer-events: none`
     reached Cesium and got processed in the locked frame, fighting
     our externally-driven pose. Now flipped to `false` (master kill-
     switch) on top of the per-mode flags.
  2. `syncCamera` used `lookAtTransform(viewerToEcef)` to write
     position/direction/up in viewer-space. `lookAtTransform` _locks_
     Cesium's reference frame; rotate/tilt/zoom operations are then
     constrained to that local frame — the "stuck to terrain plane"
     behaviour. Refactored to clear `lookAtTransform` with
     `Matrix4.IDENTITY` and write position/direction/up directly in
     ECEF (Cesium's RTC handles shader precision for primitives).

  **Network hygiene.** `queryTerrainElevation` (Open-Meteo) gets a 5 s
  `AbortController` timeout and a `console.warn` so failures are
  visible instead of silently swallowed.

- [#622](https://github.com/louistrue/ifc-lite/pull/622) [`28db7df`](https://github.com/louistrue/ifc-lite/commit/28db7df0fa64dc8cab0d08f4948fb1d9b67e0f70) Thanks [@louistrue](https://github.com/louistrue)! - Apply IfcMapConversion.Scale per IFC schema (issue #595).

  Scale converts local engineering coordinates (in the project length unit)
  to map CRS units (e.g. `0.001` for a millimetre project with a metre map).
  ifc-lite's geometry pipeline already converts vertices to metres during
  extraction, so applying the raw Scale to viewer-space coordinates double-
  scaled the model — making the Cesium 3D world context unusable for files
  authored per spec.

  Introduces `getEffectiveHorizontalScale(scale, mapUnitScale, lengthUnitScale)`
  which returns `(scale × mapUnitScale) / lengthUnitScale` — the correct
  multiplier for metre-converted geometry. For files where Scale is set
  consistently with the unit difference this evaluates to 1.0 and the
  geometry passes through unchanged. Wired through:

  - `cesium-bridge.ts` — 3D model origin and the viewer→ENU rotation.
  - `CesiumOverlay.tsx::buildModelMatrix` — GLB placement.
  - `reproject.ts` — 2D map centre, footprint, and reverse-pick.
  - `useIfcFederation.ts` — multi-model alignment transform.

  Adds a visible amber warning in the Georeferencing panel when
  `Scale × mapUnitScale ≠ lengthUnitScale` (the IFC schema invariant) so
  authoring errors are discoverable. The warning surfaces both inline (in
  the expanded Coordinate Operation section) and as a small indicator on
  the collapsed section header.

- Updated dependencies [[`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43), [`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43), [`5439cce`](https://github.com/louistrue/ifc-lite/commit/5439cce34edaff1c050ce8975a330163167df6fd)]:
  - @ifc-lite/data@1.16.0
  - @ifc-lite/ids@1.15.0
  - @ifc-lite/geometry@1.17.1
  - @ifc-lite/lists@1.14.11

## 1.19.1

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d), [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
  - @ifc-lite/mcp@0.2.0

## 1.19.0

### Minor Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - E57 reader (subset) + clear errors when users drop unsupported formats.

  **E57 (ASTM E2807-11) reader.**

  - 48-byte FileHeader parser (`ASTM-E57` magic + xmlPhysicalOffset/Length
    - pageSize).
  - Page-CRC stripping: every 1024-byte physical page ends with 4 bytes
    of CRC32-C; we strip them to get the logical view that XML offsets
    reference. CRCs aren't validated (faster + still correct on
    well-formed files).
  - XML parser via `DOMParser` walks `e57Root → data3D → vectorChild` and
    extracts each scan's record count, binary fileOffset, and prototype
    fields.
  - Binary section decoder walks DataPackets, reads bytestream length
    table, decodes uncompressed Float32 / Float64 cartesianX/Y/Z plus
    optional Float colors and Integer u8 colorRed/Green/Blue.
  - ScaledIntegerNode encoding throws a clear error so the host can guide
    the user to a Float-encoded export.

  **Drop UX.** Dropping a file we can't load (Recap `.rwp/.rwi/.rwcx/.dmt`,
  `.skp`, `.zip`, Faro `.fls`, ASCII `.pts/.xyz`) now shows an
  explanatory toast describing what the format is and what to do
  (typically: "export to E57 / LAS / PLY"). Previously the drop was
  silently rejected.

  **File picker** accepts `.e57` in browser drop, the native dialog, and
  the recent-files command palette.

  7 new pointcloud unit tests cover the FileHeader parser, page-CRC
  stripping (full pages and partial trailing page), the binary packet
  walker on a hand-built single-packet scan with Float64 cartesianX/Y/Z

  - uint8 RGB, and the ScaledInteger error path.

  Tests: 48 pointcloud unit tests pass, full repo typecheck (24/24),
  test suite green (22 runs), viewer Vite build emits decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ loading + add PLY / PCD as standalone formats; sliders feel
  responsive on first contact.

  **LAZ silently failed to load.** `laz-perf` is shipped as CommonJS,
  which Vite/webpack wrap under `.default` differently across builds.
  The previous probe only checked `lazPerf.createLazPerf` and
  `lazPerf.default` (as a function), so all real-world LAZ loads threw
  "could not find createLazPerf factory". The probe now walks four
  candidate shapes (named export, `default.createLazPerf`, `default` as
  function, namespace-as-function) and reports the visible keys when
  none match.

  **PLY + PCD now load directly.** Two new streaming sources backed by
  the existing format decoders:

  - `PlyStreamingSource` — ASCII + binary little/big-endian, optional
    RGB (uchar) + intensity. Header probe (64 KB) + whole-file decode.
  - `PcdStreamingSource` — wraps `decodePcd` (already supported PCD
    ASCII / binary / binary_compressed via inline LZF).

  Both use stride downsampling for the host's 25M-point cap.

  **Format detection** sniffs `.ply` (magic "ply"), `.pcd` (`# .P` or
  `.PCD` token), and the existing `.las/.laz` paths.

  **File picker** accepts `.ply` and `.pcd` in browser drop, the native
  dialog, and the recent-files command palette.

  **Slider UX.** Default size mode is now `fixed-px` (was `attenuated`).
  The previous default felt inert because the slider in `attenuated` mode
  is the upper _cap_ on adaptive sizing — at typical wide views the
  projected world-radius sat well below the cap, so dragging the slider
  1↔20 px never engaged. `fixed-px` always uses the slider value, and
  "Auto" is one click away when users want adaptive behaviour.

  **Worker URL fix.** `worker-client.ts` now imports
  `./decode-worker.ts` (matching geometry's pattern) so Vite's worker
  plugin resolves through the source-alias path. The package's build
  script post-rewrites that to `.js` for dist consumers.

  Tests: 41 pointcloud unit tests pass (7 new for PLY ascii/binary +
  header probe + truncation), full repo typecheck (24/24), full test
  suite (22 runs green), viewer Vite build emits the decode-worker
  chunk correctly.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Three Codex review fixes on the streaming ingest path.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix two regressions that prevented point clouds from rendering in the viewer:

  1. **IFCx samples extracted zero points.** The entity extractor required
     `bsi::ifc::class` on every node before assigning an `expressId`, but the
     buildingSMART Point*Cloud*\*.ifcx fixtures place `pcd::base64` /
     `points::array` / `points::base64` on nodes that carry only USD
     `xformop`. Those nodes now also become first-class entities (synthetic
     `IfcGeographicElement` type) so the point cloud extractor can emit
     them. Added regression assertions in `verify-dist-hello-wall.mjs`.

  2. **`.las` / `.laz` files were silently ignored on single-file load.**
     The drop / picker single-file path goes through `useIfcLoader.loadFile`,
     which only branched on `ifcx` / `glb` / `ifc`. Added the LAS/LAZ branch
     there and wired it into the streaming ingest. Camera fit-to-view now
     triggers from `usePointCloudSync` for points-only scenes (the geometry
     streaming hook bails out early when there are no meshes).

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix `TypeError: entities.getTypeName is not a function` when picking a
  point on a streamed point cloud (LAS / LAZ / PLY / PCD / E57).

  The synthetic `IfcDataStore` that `pointCloudIngest.ts` builds for
  point-cloud-only models stubbed `entities` with only a handful of
  methods (`getId`, `getType`, `getName`, `getGlobalId`) and used method
  names that don't match the real `EntityTable` interface. Picking
  selects the synthetic expressId, which routes through the regular
  property / hover / properties-panel pipeline — that pipeline calls
  `entities.getTypeName`, `entities.getTypeEnum`,
  `properties.getForEntity`, etc., and crashed on the missing
  `getTypeName`.

  `emptyDataStore()` now produces a stub that matches the real shape:

  - `entities`: `count=1`, `expressId=Uint32Array([id])`, `typeEnum`,
    plus `getTypeName` → `'IfcGeographicElement'`, `getName` → file
    name, `getGlobalId` → `pointcloud-<id>`, and `getTypeEnum`,
    `getByType`, `hasGeometry`, `getExpressIdByGlobalId`,
    `getGlobalIdMap` covered.
  - `properties`: real `PropertyTable` shape — `entityIndex`,
    `psetIndex`, `propIndex`, `getForEntity`, `getPropertyValue`,
    `findByProperty` (all empty / no-op).
  - `quantities` / `relationships`: matching empty stubs.
  - `entityIndex.byType` includes `IFCGEOGRAPHICELEMENT → [id]` so type
    filters resolve.

  `emptyDataStore` now takes the synthetic `expressId` and `fileName` so
  the stub round-trips real data instead of `undefined`.

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

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Streaming point clouds (LAS / LAZ / PLY / PCD / E57) now arrive in
  the renderer's Y-up convention, matching the IFCx ingest path.

  Without this, scans rendered rotated 90° onto their side because the
  renderer is Y-up internally and LIDAR / surveying formats store data
  Z-up by convention. The IFCx path applied the swap inside
  `pointcloud-extractor.ts`; the streaming path went straight from the
  worker's decoded chunk into `appendPointCloudChunk`, skipping the
  swap.

  `ingestPointCloud` now wraps `onChunk` to re-orient positions and
  bbox before forwarding to the renderer:
  Z-up: X=right, Y=forward, Z=up
  Y-up: X=right, Y=up, Z=back (negate Y to keep right-hand rule)

  Mirrors the geometry / pointcloud extractors' existing handling.

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/pointcloud@0.2.0
  - @ifc-lite/renderer@1.18.0
  - @ifc-lite/geometry@1.17.0
  - @ifc-lite/parser@2.3.0

## 1.18.0

### Minor Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add Element tool — instant 3D appearance, off-surface placement, 3D ghost preview.

  Three UX-blocker fixes that turn the Add Element tool into a real
  authoring surface (previously every drop emitted STEP into the overlay
  but the user saw nothing in the 3D scene until export+reparse).

  - **Instant 3D appearance.** Every `add*` action now also builds a
    renderer-frame mesh for the new element and injects it via the
    same `appendGeometryBatch` action `duplicateEntity` uses. Walls,
    beams, and members are oriented thickness-extruded boxes;
    columns, doors, and windows are axis-aligned boxes;
    slabs / roofs / plates / spaces are polygon extrusions (with fan
    triangulation good enough for typical room shapes). Storey
    elevation is read from the spatial hierarchy so multi-storey
    placements drop on the right floor. The new mesh is tagged with
    the federation-aware globalId so picking + selection work
    immediately and the property panel opens on the new entity.
  - **Off-surface placement.** A new
    `raycastStoreyFloor()` helper unprojects the cursor to a ray and
    intersects the storey floor plane (renderer Y =
    `storeyElevation`). The hover preview and click handler both
    fall back to it when the scene raycast misses, so columns can
    drop onto empty floor outside the existing geometry. Snap-to-
    surface still wins whenever there is a mesh under the cursor.
  - **3D ghost preview.** The SVG overlay now projects the about-to-
    commit element's 8 corners (or polygon ring) to screen and
    renders the silhouette via a convex-hull outline. Single-click
    types (column / door / window) show the ghost on hover before
    any clicks; two-click types (wall / beam / member) show it once
    the start point is placed. The ghost reads live per-type form
    params, so adjusting Width / Height / Thickness updates it in
    real time.

  Also includes a panel polish: when the active type is `space` an
  **Auto Spaces** section appears with snap tolerance, min area,
  height, naming pattern, and IfcSpaceTypeEnum settings + Preview /
  Generate buttons that drive the wall-graph face finder.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Annotate-in-3D — drop pins on the scene with notes.

  Press `P` (or pick the new `MapPin` button on the main toolbar),
  click anywhere in the 3D scene, type a note. A pin lands at the
  world point you clicked on, persists to localStorage, and re-anchors
  itself as you orbit / pan. Pins are 14px amber dots with a
  1-character glyph (numbered ≤ 9, dot beyond), drop shadow, idle-pulse
  on first paint (respects `prefers-reduced-motion`), emerald selection
  ring matching the existing constructive accent.

  Flow:

  - `P` toggles the Annotate tool. Toolbar gains a `MapPin` button
    with an amber active-tone, distinct from the primary blue used
    for Select / Walk / Measure / Section.
  - Cursor switches to crosshair while annotating.
  - Click → raycast into the scene → on hit, an inline note input
    drops at the click site with a guiding "What's worth noting?"
    label and the entity context inline (e.g. `· IfcSlab #2036`).
    Misses are silent — annotations are anchored to surface points
    by design, not floating in space.
  - `Enter` saves, `⇧Enter` newline, `Esc` cancels. Outside-click
    saves a non-empty draft and silently cancels an empty one.
  - Click an existing pin → popover with note + relative time +
    pen / trash icons. Edit mode mirrors the drop-input treatment.
  - Tool stays active across drops so you can drop several pins
    in sequence.

  Architecture:

  - New `annotationsSlice` — Map-keyed store (`begin/commit/cancel
Draft`, `update`, `remove`, `select`, `clearAll`). Notes are
    clamped at 2000 chars, soft-warned at 200. Persists to
    `ifc-lite:annotations:v1` in localStorage and survives a fresh
    slice instantiation. Covered by 9 unit tests.
  - New DOM-billboard overlay (`AnnotationLayer`) sitting on top of
    the WebGPU canvas. A single rAF loop re-projects every pin's
    world position to screen via `cameraCallbacks.projectToScreen`,
    skipping `setState` when nothing changed (so the loop is cheap
    when the camera is still). Pointer-events: none on the wrapper
    so empty space passes through to canvas controls; pins +
    popover opt back into pointer events explicitly.
  - `AnnotationPin`, `AnnotationPopover`, `AnnotationDropInput` —
    composable components, all amber-accented, edge-clamped,
    backdrop-blurred where it matters.

  Pins are NOT IFC entities — they live alongside the model as an
  authoring overlay. Future PRs will wire BCF round-trip and
  IfcAnnotation export, plus an annotations-list panel and category
  tags.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — diagnostics, broader wall coverage, and a sweep of
  review feedback.

  **Auto Spaces detection.** The "no enclosed regions detected"
  failure mode now surfaces actionable counts — both in devtools
  and in the panel itself.

  - `extract-walls.ts` now tries the standard `Axis` representation
    (`IfcShapeRepresentation` with `RepresentationIdentifier='Axis'`,
    `IfcPolyline` items) **before** falling back to the
    `addWallToStore` rectangle-profile convention. That covers
    walls authored by Revit / ArchiCAD / IfcOpenShell — the previous
    extractor only handled walls placed via the Add Element tool.
    The placement chain is read once and the polyline endpoints are
    transformed through it, so rotated walls work.
  - Every wall that gets dropped is recorded with a typed reason
    (`no-axis-or-rect-profile`, `placement-not-resolvable`,
    `zero-length-axis`, …) — the panel summarises them as
    `"3× no-axis-or-rect-profile, 1× zero-length-axis"`.
  - `detectEnclosedAreas` exposes a
    `detectEnclosedAreasWithStats(...)` companion that returns
    per-stage counts (vertices, edges-after-split, faces total,
    outer / below-min-area drops, largest area). The intersection
    splitter's iteration cap now scales with input size
    (`max(100, segments * 10)`) so dense floor plans don't bail
    out early.
  - `generateSpacesFromWalls` always logs a `console.info`
    one-liner and threads a new `debug?: boolean` flag down to the
    extractor + detector for verbose tracing. The viewer's Auto
    Spaces panel exposes a "Verbose console logging" checkbox.
  - The Auto Spaces diagnostic block now shows the graph stats
    (`123v / 456e / 78f`), the drop counts, and per-reason wall
    skips. Two amber hints fire automatically when walls were
    extracted but no faces formed (likely snap tolerance), or
    when nothing extracted (likely an unsupported geometry shape).

  **Review-feedback sweep (PR #598).**

  - `addElementMeshes.linearBox()` and the SVG `linearBoxCorners`
    helper honour each endpoint's Y so a sloped beam previews as
    a sloped prism instead of being flattened to the start.
  - `bridge-store.requireStoreyId` rejects `0` (EXPRESS ids are
    1-based, `#0` is never valid).
  - `addWindow` / `addDoor` `tsParamTypes` include
    `UserDefinedPartitioningType` / `UserDefinedOperationType`
    so typed sandbox callers can hit the IFC4 round-trip without
    casts.
  - `AnnotationLayer.resolveEntityType` no longer falls back to
    `ifcDataStore` when the annotation's `modelId` is missing
    from a federated `models` map (would resolve the wrong
    entity in multi-model sessions). Single-model sessions keep
    the fallback.
  - `addDoorToStore` / `addWindowToStore` validate
    `OperationType` / `PartitioningType` against the IFC4 enum
    and re-route unknown values through
    `.USERDEFINED.` + `User-defined…Type` so custom labels
    round-trip cleanly.
  - `addWallToStore` defaults `PredefinedType` to `.NOTDEFINED.`
    (was `.STANDARD.`) to match the rest of the in-store
    builders.
  - `duplicateInStore` / `resolveDuplicateSource` allow
    `OwnerHistory` to be `null` (IFC4 made it optional). The
    duplicate emits a bare `$` token instead of `#null` for the
    omitted case.
  - `StoreEditor.addEntity` accepts an injected schema-aware
    normalizer (`setEntityTypeNormalizer`); `@ifc-lite/sdk`
    registers `normalizeIfcTypeName` + `isKnownType` at load
    time so direct callers — CLI scripts, sandbox bridge,
    unit tests — see registry-grade rejection of typos like
    `IfcWal`, plus canonical PascalCase on `EntityRef.type`.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — generate IfcSpace volumes from a storey's walls.

  Pick the **Space** type in the Add Element panel and the new **Auto
  Spaces** section appears underneath the dimensions. Hit **Preview** to
  see every enclosed region the wall graph forms (live SVG overlay,
  labelled with area), then **Generate** to commit one IfcSpace per
  region. Settings: snap tolerance (collapse sloppy wall ends), min area
  (drop closets and slivers), height (extrusion), name pattern, and
  IfcSpaceTypeEnum.

  **`@ifc-lite/create`** — three new modules, all parser-pure:

  - `auto-space-detect.ts` — planar-graph face finder. Snap →
    resolve crossings → DCEL half-edge graph → leftmost-turn cycle
    walk → drop unbounded faces → filter by min area. Handles
    multi-component layouts (two non-touching rooms find both),
    T-junctions, and snap-induced corner merges. 8 fixture tests.
  - `extract-walls.ts` — pulls every wall axis on a target storey
    from a parsed `IfcDataStore`. Walks
    IfcRelContainedInSpatialStructure → IfcWall → placement chain →
    IfcRectangleProfileDef.XDim. Optional overlay reader includes
    walls created via the Add Element tool without a re-parse.
  - `generate-spaces.ts` — orchestration: extract → detect → emit
    via `addSpaceToStore` polygon mode. `dryRun` runs detection only.

  **`@ifc-lite/viewer`** — `mutationSlice.generateSpacesFromWalls`
  returns the detection result. `AddElementPanel` gains the Auto Spaces
  section; `AddElementOverlay` projects detected outlines back to screen
  using the storey's elevation so the preview tracks the camera in
  real time.

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

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Duplicate-from-selection — pick any IfcRoot product, hit `⌘D` (or
  right-click → Duplicate), get a fully-functional clone. The
  duplicate is a first-class entity in the property panel, exports
  cleanly to STEP with all its property associations preserved, and
  ships in 6 directional variants sized to the source's bounding box.

  **`@ifc-lite/create`**

  - New `duplicateInStore(editor, source, options)` pure builder.
    Emits a fresh placement chain (`IfcCartesianPoint` →
    `IfcAxis2Placement3D` → `IfcLocalPlacement`) plus the duplicate
    `IfcRoot` with a new GUID and the source's `Representation`
    reference reused (geometry shared). Optional fresh
    `IfcRelContainedInSpatialStructure` anchors to the source's
    storey. Offset is configurable via `options.offset` — the slice
    sizes it to the source's bbox.
  - New `resolveDuplicateSource(store, expressId)` walks the parsed
    `IfcDataStore` for placement / parent / location / storey /
    associations.
  - New `SourceAssociation` shape captures one
    `IfcRelDefines*` / `IfcRelAssociates*` edge that references
    the source. The builder replays each one against the duplicate
    so the exported STEP carries identical psets / qsets /
    materials / classifications / documents / type binding —
    without modifying any existing rel.
  - Resolver scans the five association rel types
    (`IFCRELDEFINESBYPROPERTIES`, `IFCRELDEFINESBYTYPE`,
    `IFCRELASSOCIATESMATERIAL`, `…CLASSIFICATION`, `…DOCUMENT`)
    by direct numeric membership in `RelatedObjects`.
  - `DuplicateBuildResult.associationRelIds: number[]` exposes the
    fresh rel ids for caller introspection.
  - 7 unit tests in `duplicate.test.ts`: full graph emission,
    custom offset, no-storey path, root-placement parent, attribute
    count guard, association replay (3 rel types in one go), and
    the no-associations case.

  **`@ifc-lite/mutations`**

  - New `setEntityAlias(overlayId, sourceId | null)` /
    `getEntityAlias(id)` / `resolveBaseEntityId(id)` public surface
    on `MutablePropertyView`. Aliases redirect base property and
    quantity reads from the duplicate to its source — so the
    duplicate inherits psets/qsets without eagerly cloning them
    into the overlay.
  - Override slots stay scoped to the original (overlay) id, so
    edits on the duplicate don't bleed into the source. Verified
    by 4 new unit tests including the source-untouched path,
    chain-cap (one hop, not transitive), and the self-alias guard.

  **`@ifc-lite/viewer`**

  - New `duplicateEntity(modelId, sourceExpressId, direction?)`
    slice action. Wraps the create-package builder, sets the
    mutation-view alias, and clones the source's mesh data into
    the geometry result with the offset applied — so the duplicate
    appears in 3D the moment the action fires, not just in the
    export overlay. Per-vertex `entityIds` arrays are filled with
    the new globalId so picking and selection resolve correctly.
  - New `DuplicateDirection` type (`+X` / `-X` / `+Y` / `-Y` /
    `+Z` / `-Z`). Magnitude per axis = the source's bounding-box
    dimension on that axis, so a 3m wall steps 3m and a 0.4m
    column steps 0.4m. Falls back to a 1m step when the source
    has no mesh in geometry.
  - Right-click menu's "Duplicate" item is now a `DuplicateRow`:
    primary clickable label on the left (defaults to +X), 6 axis
    chips on the right (→ ← ↗ ↙ ↑ ↓). Tooltips spell out
    "+X (east)" through "−Z (down)".
  - `⌘D` defaults to +X. `⇧⌘D` = +Z (up), `⌥⌘D` = +Y (north) —
    modifier shortcuts for power users without forcing a mouse
    trip to the chip row. Selection moves to the new globalId so
    a Cmd+D chain ("stamp a row of columns") works without
    re-clicking.
  - **`resolveGlobalIdFromModels` two-pass overlay fallback** —
    the federation resolver previously gated each model's id range
    at parse-time `maxExpressId`, which excluded every
    overlay-allocated id from selection. The fix: a second pass
    consults each model's mutation view via `getNewEntity(localId)`
    so overlay duplicates resolve to the right model with the
    right local id. Without this, the property panel saw the
    duplicate as "UNKNOWN / Unknown / no property sets" because
    the alias couldn't take effect on a wrongly-resolved id.
  - PropertiesPanel falls back to the overlay `NewEntity` record
    for type / name / GUID / Description / ObjectType when the
    parsed `entityNode` comes up empty. The bSDD attribute list
    synthesises from the schema-defined positional names. The
    Materials / Classifications / Documents / structural
    Relationships sections all route through a new
    `lookupExpressId` (alias-resolved) so they query the source's
    parsed maps directly.

  After: a freshly-duplicated wall is genuinely first-class — name
  reads, properties show, quantities show, material layers show,
  classifications show, documents show, and a round-tripped STEP
  file carries every association.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add the full IfcTask / 4D construction-schedule experience to the viewer.

  **Gantt panel** — a lower-panel workspace combining a task tree, a zoomable
  SVG timeline with task bars / milestones / dependency arrows / playback
  cursor, a toolbar (work-schedule filter, play / pause / loop / speed, time
  scale), and an empty state. Live Gantt ↔ 3D selection highlight (one-way,
  no isolation) and playback-driven visibility through the rendererʼs
  hidden-entity channel.

  **Schedule editing** — Inspector Task card (name, identification,
  predefined type, milestone, start / finish / duration with any-two-of-three
  reconciliation, assigned products, delete with cascade). Undo / redo
  (descriptor-based lightweight snapshots for field edits; full snapshot for
  structural edits), store-scoped transactions (drag-coalesced), add / delete /
  reorder tasks. IFC STEP export routes through a centralised schedule splice
  helper so generated / edited schedules round-trip cleanly on every export
  surface.

  **Generate from hierarchy** — a Generate Schedule dialog produces a work
  schedule + tasks from the modelʼs spatial hierarchy (Storey / Building) or
  geometry (Height-slice, with optional Class / Type / Name subgroup). Linked
  FS dependencies and ghost-preparation look-ahead are opt-in.

  **4D animation** — Synchro-style phased lifecycle (preparation ghost →
  ramp-in → active task-type colour → settling fade → complete), demolition
  inversion, customizable palette, and configurable palette intensity /
  look-ahead / hide-untasked products. Animation layers live in a priority-
  composited overlay registry (`registerOverlayLayer`), with a single
  compositor hook owning the write to the rendererʼs hidden-entity + colour-
  override channels.

  **LLM integration** — built-in "Construction schedule (4D)" script template,
  PDF / spreadsheet chat attachments, and `bim.schedule.*` read APIs reachable
  from the sandbox.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Raw STEP tab — drill into `#N` references and a tighter dev-leaning
  visual treatment.

  **Reference drill-through**

  - Each `#N` token in the Raw STEP card is now a clickable chip.
    Click → drills into the target entity and shows its positional
    arguments inline; the breadcrumb at the top of the card tracks
    the path back to the 3D-selected entity.
  - **Auto-skip wrappers** — when the click target itself has only
    a single positional arg and that arg is also a `#N`, the card
    follows the chain in one click and lands on the first
    "meaningful" entity. Capped at 16 hops to defend against
    cyclic STEP graphs. So a real-world case like
    `IfcRelDefinesByProperties → IfcPropertySet` steps cleanly,
    and pure pass-through wrappers don't waste user clicks.
  - Drill state resets when the 3D selection changes — drilling
    stays scoped to a single click. Each breadcrumb segment is
    clickable to jump back to that depth.
  - Editing a `#N` ref still works via the pen icon — clicking the
    chip itself navigates instead of entering edit mode, but the
    hover-revealed pen still flips to inline-edit so a user can
    re-type the reference target.
  - Tombstoned entities short-circuit the auto-follow so the drill
    doesn't render a deleted entity's body.

  **True STEP literals on display**

  - Tokens are read directly from the source bytes via a new
    `extractRawStepTokens` helper, so refs render as `#42`, enums
    stay `.AREA.`, and strings keep their on-disk quoted form. The
    EntityExtractor's parsed JS shape strips reference prefixes
    (it parses `#42` into the integer `42`), so the previous
    formatter had no way to recover the distinction — `OwnerHistory`
    would render as `18` instead of `#18`. Fixed.
  - Overlay overrides serialize back through `serializeStepToken`
    for parity with the unmodified base tokens.

  **Overlay-aware row display**

  - Edits to positional attributes now reflect immediately in the
    row body. Previously the card re-extracted from the source
    buffer and ignored the overlay map, so the displayed value
    snapped back to the original after Save (only the purple
    overlay-override dot updated correctly).

  **Dev-leaning tab styling**

  - Raw STEP tab restyled — replaces the "Raw" plain-text label
    with a `</>` bracket glyph, shrinks the trigger to icon-only
    width via `flex: 0 0 auto`. Frees up width so Properties /
    Quantities / bSDD keep their text visible at the default
    panel size, and signals "developer view" with a terminal-green
    accent on hover / active state.

  **Add-Column UI removed**

  - The original `AddColumnDialog` + context-menu "Add column
    here…" + EditToolbar "Column" button — premature for the
    current workflow (single hard-coded element type with no
    geometry preview). Removed cleanly:
    `AddColumnDialog.tsx` (deleted), the `addColumnDialog` slice
    state, the constructive `MenuItem` tone (only used by that
    item), and the context-menu / toolbar entry points.
  - Kept: the `addColumn` slice action and the
    `bim.store.addColumn` SDK surface — those still drive scripts
    and programmatic flows, just no UI affordance for now.

  **Tombstoned mesh actually disappears**

  - Delete entity now pairs the overlay tombstone with
    `hideEntity(globalId)` so the rendered mesh is hidden from the
    GPU buffers (and stops being pickable). Undo of `DELETE_ENTITY`
    pairs `restoreFromTombstone` with `showEntity` so the entity
    returns to the scene; redo re-hides. Symmetrical round-trip.

- [#588](https://github.com/louistrue/ifc-lite/pull/588) [`b75f0cc`](https://github.com/louistrue/ifc-lite/commit/b75f0cccb06c89f5e30272d6c04f986f3b47e574) Thanks [@louistrue](https://github.com/louistrue)! - Replace the SQL tab in the advanced search modal with a clean
  chip-based **Filter** tab. Storey / IFC type / Predefined type / Name /
  Property / Quantity rules compose with AND/OR + IsSet/IsNotSet and
  run through an in-memory evaluator that scales to 4M-entity models
  via `entityIndex.byType` / `spatialHierarchy.byStorey` prefilter,
  cheap-first per-entity rule ordering, and async chunked yielding
  with cancel + progress. The DuckDB engine, SQL editor, schema
  browser, templates, error rewriter, and saved-SQL-queries module
  have been removed — Builder is the whole UI now, with a single Run
  button and CSV/JSON export. Builder dropdowns are schema-aware
  (storeys + IFC types load eagerly, pset / qto names load lazily on
  first use), the inline search-bar query promotes to a Name rule
  with one click, multi-model row clicks route to the correct model,
  and saved presets persist named `{name, combinator, rules}`
  snapshots in localStorage.

### Patch Changes

- [#588](https://github.com/louistrue/ifc-lite/pull/588) [`b75f0cc`](https://github.com/louistrue/ifc-lite/commit/b75f0cccb06c89f5e30272d6c04f986f3b47e574) Thanks [@louistrue](https://github.com/louistrue)! - Address PR #588 review feedback that survived the Filter migration:

  - Inline-bar Enter now flushes the 80ms debounce by re-scanning against
    the live `searchQuery`, so committing inside the debounce window
    selects the entity matching what the input shows (not the prior
    query) and records the correct recent.
  - The 50ms `frameSelection` timer in the inline bar is tracked via a
    ref and cleared on rapid selection changes / unmount instead of
    leaking orphan callbacks.
  - Shift+Enter additive selection in the inline bar and the row-level
    additive path in the Search modal now TOGGLE via `toggleEntitySelection`,
    so the same interaction can deselect a previously-added row.
  - New `addEntitiesToSelection` batch action on the selection slice;
    the Search modal's "Select all" path uses it so a 5K-row select-all
    dispatches one Zustand `set` instead of N.
  - Tier-0 scoring now keeps the max across name/type/objectType/description
    fields (matching Tier-1's behaviour). Without this, an entity with a
    substring name hit and a type-exact hit ranked lower than it should
    on Tier-0, breaking the comparable-ordering guarantee when results
    came from a mix of Tier-0 and Tier-1 models.

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04), [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`370e084`](https://github.com/louistrue/ifc-lite/commit/370e084e94e8fce930bddf948344c4b639d196f3), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/sdk@1.15.0
  - @ifc-lite/sandbox@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/geometry@1.16.6
  - @ifc-lite/renderer@1.17.0
  - @ifc-lite/query@1.14.7
  - @ifc-lite/wasm@1.16.7
  - @ifc-lite/export@1.18.0

## 1.17.6

### Patch Changes

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Rotate mesh normals alongside positions when aligning federated models and honour georef mutations during alignment, so secondary models keep correct shading and stay aligned when their georeferencing is edited after load.

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Extract LLM stream routing into a shared helper and handle Codex's truncation marker so long responses are no longer cut off mid-sentence. BYOK guard logic moves into its own module with unit tests covering the direct-stream path.

- Updated dependencies [[`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966), [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966)]:
  - @ifc-lite/wasm@1.16.6

## 1.17.5

### Patch Changes

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

- Updated dependencies [[`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805), [`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1)]:
  - @ifc-lite/renderer@1.16.0
  - @ifc-lite/drawing-2d@1.15.3
  - @ifc-lite/wasm@1.16.5

## 1.17.4

### Patch Changes

- [#531](https://github.com/louistrue/ifc-lite/pull/531) [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e) Thanks [@louistrue](https://github.com/louistrue)! - Fix browser build warnings and improve streaming reliability

  - Silence FileDialog Tauri warnings in browser builds (expected fallback path)
  - Fix closeGeometryIterator ReferenceError when geometry processor throws before iterator creation
  - Guard timer-based queue pump behind document.hidden to prevent redundant GPU flushes in foreground tabs

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b), [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e)]:
  - @ifc-lite/geometry@1.16.5
  - @ifc-lite/wasm@1.16.4
  - @ifc-lite/renderer@1.15.2

## 1.17.3

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix type properties and type info display when selecting occurrence elements

- Updated dependencies [[`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b), [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b)]:
  - @ifc-lite/renderer@1.14.9

## 1.17.2

### Patch Changes

- [#447](https://github.com/louistrue/ifc-lite/pull/447) [`e532dfe`](https://github.com/louistrue/ifc-lite/commit/e532dfef16bedbdb7b106d610b88a97e723721c3) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/renderer@1.14.7
  - @ifc-lite/wasm@1.16.0
  - @ifc-lite/drawing-2d@1.15.0
  - @ifc-lite/export@1.17.0
  - @ifc-lite/geometry@1.16.0
  - @ifc-lite/server-client@1.15.0

## 1.17.1

### Patch Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers to vercel.json for SharedArrayBuffer support in production deployments.

- Updated dependencies [[`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6), [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6)]:
  - @ifc-lite/wasm@1.15.0
  - @ifc-lite/geometry@1.15.0

## 1.17.0

### Minor Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D BCF topic marker overlay that positions markers above referenced geometry, tracks camera movement in real-time, and supports click/hover interactions with the BCF panel

### Patch Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Make BCF 3D overlay markers opt-in with a MapPin toggle button in the BCF panel header, defaulting to off for zero performance cost when unused

- [#419](https://github.com/louistrue/ifc-lite/pull/419) [`87ce884`](https://github.com/louistrue/ifc-lite/commit/87ce8841175e64394445833e66bd77a8a68668e9) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d), [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d)]:
  - @ifc-lite/bcf@1.15.0

## 1.16.0

### Minor Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Use Material Symbols IFC class icons in hierarchy panel for improved visual clarity

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Add double-escape keyboard shortcut to close all panels and return to starting view

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Show all package versions in viewer

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8), [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/wasm@1.14.4
  - @ifc-lite/parser@2.1.1
  - @ifc-lite/renderer@1.14.4
  - @ifc-lite/export@1.15.1

## 1.15.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Include IfcSpace elements in storey isolation and add combinable class/type/storey filters

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix viewer.isolate() hiding everything when passed spatial structure elements like storeys

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix mutation state not resetting when opening a new file

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f)]:
  - @ifc-lite/ids@1.14.4
  - @ifc-lite/export@1.15.0
  - @ifc-lite/parser@2.1.0
  - @ifc-lite/encoding@1.14.4
  - @ifc-lite/lists@1.14.4

## 1.14.4

### Patch Changes

- [#339](https://github.com/louistrue/ifc-lite/pull/339) [`691f8a5`](https://github.com/louistrue/ifc-lite/commit/691f8a57ad51c0649de0dbcd17f4b7ecd48e7da7) Thanks [@louistrue](https://github.com/louistrue)! - Expose the Script Editor from a new Panels menu and consolidate auxiliary panel toggles in the viewer toolbar.

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0
  - @ifc-lite/export@1.14.4
  - @ifc-lite/query@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/sandbox@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/export@1.14.3
  - @ifc-lite/bcf@1.14.3
  - @ifc-lite/cache@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/drawing-2d@1.14.3
  - @ifc-lite/encoding@1.14.3
  - @ifc-lite/ids@1.14.3
  - @ifc-lite/lens@1.14.3
  - @ifc-lite/lists@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/query@1.14.3
  - @ifc-lite/renderer@1.14.3
  - @ifc-lite/server-client@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3), [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/export@1.14.2
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/bcf@1.14.2
  - @ifc-lite/cache@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/drawing-2d@1.14.2
  - @ifc-lite/encoding@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/ids@1.14.2
  - @ifc-lite/lens@1.14.2
  - @ifc-lite/lists@1.14.2
  - @ifc-lite/mutations@1.14.2
  - @ifc-lite/query@1.14.2
  - @ifc-lite/renderer@1.14.2
  - @ifc-lite/sandbox@1.14.2
  - @ifc-lite/server-client@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0)]:
  - @ifc-lite/renderer@1.14.1
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/sandbox@1.14.1
  - @ifc-lite/bcf@1.14.1
  - @ifc-lite/cache@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/drawing-2d@1.14.1
  - @ifc-lite/encoding@1.14.1
  - @ifc-lite/export@1.14.1
  - @ifc-lite/ids@1.14.1
  - @ifc-lite/lens@1.14.1
  - @ifc-lite/lists@1.14.1
  - @ifc-lite/mutations@1.14.1
  - @ifc-lite/query@1.14.1
  - @ifc-lite/server-client@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.14.0
  - @ifc-lite/cache@1.14.0
  - @ifc-lite/data@1.14.0
  - @ifc-lite/drawing-2d@1.14.0
  - @ifc-lite/encoding@1.14.0
  - @ifc-lite/export@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/ids@1.14.0
  - @ifc-lite/lens@1.14.0
  - @ifc-lite/lists@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/query@1.14.0
  - @ifc-lite/renderer@1.14.0
  - @ifc-lite/sandbox@1.14.0
  - @ifc-lite/server-client@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies [[`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c), [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c)]:
  - @ifc-lite/renderer@1.13.0
  - @ifc-lite/bcf@1.13.0
  - @ifc-lite/cache@1.13.0
  - @ifc-lite/data@1.13.0
  - @ifc-lite/drawing-2d@1.13.0
  - @ifc-lite/encoding@1.13.0
  - @ifc-lite/export@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/ids@1.13.0
  - @ifc-lite/lens@1.13.0
  - @ifc-lite/lists@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/query@1.13.0
  - @ifc-lite/sandbox@1.13.0
  - @ifc-lite/server-client@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Minor Changes

- [#268](https://github.com/louistrue/ifc-lite/pull/268) [`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 (IFCX) export with full schema conversion and USD geometry

  New `Ifc5Exporter` converts IFC data from any schema (IFC2X3/IFC4/IFC4X3) to the IFC5 IFCX JSON format:

  - Entity types converted to IFC5 naming (aligned with IFC4X3)
  - Properties mapped to IFCX attribute namespaces (`bsi::ifc::prop::`)
  - Tessellated geometry converted to USD mesh format with Z-up coordinates
  - Spatial hierarchy mapped to IFCX path-based node structure
  - Color and presentation exported as USD attributes

  The export dialog is simplified: schema selection now drives the output format automatically (IFC5 → `.ifcx`, others → `.ifc`). No separate format picker needed.

  Schema converter fixes:

  - Skipped entities become IFCPROXY placeholders instead of being dropped, preventing dangling STEP references
  - Alignment entities (IFCALIGNMENTCANT, etc.) are preserved for IFC4X3/IFC5 targets

### Patch Changes

- Updated dependencies [[`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7)]:
  - @ifc-lite/export@1.12.0
  - @ifc-lite/bcf@1.12.0
  - @ifc-lite/cache@1.12.0
  - @ifc-lite/data@1.12.0
  - @ifc-lite/drawing-2d@1.12.0
  - @ifc-lite/encoding@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/ids@1.12.0
  - @ifc-lite/lens@1.12.0
  - @ifc-lite/lists@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/query@1.12.0
  - @ifc-lite/renderer@1.12.0
  - @ifc-lite/sandbox@1.12.0
  - @ifc-lite/server-client@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- [#258](https://github.com/louistrue/ifc-lite/pull/258) [`6c5f36d`](https://github.com/louistrue/ifc-lite/commit/6c5f36ddb4ae1879788f433a45c8bab5eabeb496) Thanks [@louistrue](https://github.com/louistrue)! - Improve large-file load performance targeting ~3–5 s savings on a 326 MB IFC file.

  - Replace O(total_accumulated) `.reduce()` calls in `appendGeometryBatch` with O(batch_size) incremental totals
  - Defer data model parser to after geometry streaming completes (no main-thread CPU contention with WASM)
  - Accumulate color updates locally during streaming; apply single `updateMeshColors()` at complete
  - Disable IndexedDB caching for files above 150 MB (source buffer required for on-demand extraction)

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.3
  - @ifc-lite/cache@1.11.3
  - @ifc-lite/data@1.11.3
  - @ifc-lite/drawing-2d@1.11.3
  - @ifc-lite/encoding@1.11.3
  - @ifc-lite/export@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/ids@1.11.3
  - @ifc-lite/lens@1.11.3
  - @ifc-lite/lists@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/query@1.11.3
  - @ifc-lite/renderer@1.11.3
  - @ifc-lite/sandbox@1.11.3
  - @ifc-lite/server-client@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- [#240](https://github.com/louistrue/ifc-lite/pull/240) [`a423e83`](https://github.com/louistrue/ifc-lite/commit/a423e8390afcb78f2de57203b26715df726335ed) Thanks [@louistrue](https://github.com/louistrue)! - Fix deferred IFC style colors not applying on first load by separating persistent mesh color updates from transient overlay color updates.

  This restores expected glass transparency and keeps first-load and cache-load colors consistent.

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/bcf@1.11.1
  - @ifc-lite/cache@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/drawing-2d@1.11.1
  - @ifc-lite/encoding@1.11.1
  - @ifc-lite/export@1.11.1
  - @ifc-lite/ids@1.11.1
  - @ifc-lite/lens@1.11.1
  - @ifc-lite/lists@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/query@1.11.1
  - @ifc-lite/renderer@1.11.1
  - @ifc-lite/sandbox@1.11.1
  - @ifc-lite/server-client@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies [[`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d), [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/renderer@1.11.0
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/bcf@1.11.0
  - @ifc-lite/cache@1.11.0
  - @ifc-lite/data@1.11.0
  - @ifc-lite/drawing-2d@1.11.0
  - @ifc-lite/encoding@1.11.0
  - @ifc-lite/export@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/ids@1.11.0
  - @ifc-lite/lens@1.11.0
  - @ifc-lite/lists@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/query@1.11.0
  - @ifc-lite/sandbox@1.11.0
  - @ifc-lite/server-client@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/renderer@1.10.0
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/wasm@1.10.0
  - @ifc-lite/ids@1.10.0
  - @ifc-lite/lists@1.10.0
  - @ifc-lite/bcf@1.10.0
  - @ifc-lite/cache@1.10.0
  - @ifc-lite/drawing-2d@1.10.0
  - @ifc-lite/encoding@1.10.0
  - @ifc-lite/export@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/lens@1.10.0
  - @ifc-lite/mutations@1.10.0
  - @ifc-lite/query@1.10.0
  - @ifc-lite/sandbox@1.10.0
  - @ifc-lite/server-client@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Minor Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Add scripting platform with sandboxed TypeScript execution and full BIM SDK.

  New packages:

  - `@ifc-lite/sandbox` — sandboxed script runner that transpiles and executes user TypeScript in a Web Worker with BIM globals (`bim.query`, `bim.select`, `bim.viewer`, etc.) isolated from the host page.
  - `@ifc-lite/sdk` — BIM SDK defining the full host↔sandbox message protocol and all namespaces: `query`, `mutate`, `viewer`, `spatial`, `export`, `lens`, `bcf`, `ids`, `drawing`, `list`, `events`.

  New viewer features:

  - **Command Palette** — `Cmd/Ctrl+K` fuzzy-search launcher for viewer actions and scripts.
  - **Script Panel** — full-screen code editor (CodeMirror) with run/stop controls, output log, and CSV download.
  - **6 built-in script templates** — quantity takeoff, fire-safety check, MEP equipment schedule, envelope check, space validation, federation compare.
  - **Recent files** — persisted list of previously opened IFC files.

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Respect system color-scheme preference on initial load.

  The app previously hardcoded dark mode. Now:

  - An inline script in `index.html` applies the correct theme class before first paint, eliminating flash of wrong theme.
  - The Zustand UI store reads from `localStorage` first, then falls back to the browser's `prefers-color-scheme` media query.
  - Theme preference persists across reloads via `localStorage`.

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix scripting CSV exports missing property and quantity data.

  - `@ifc-lite/sdk` export namespace now resolves quantity-set dot-paths (`Qto_WallBaseQuantities.NetVolume`) in addition to property-set paths, so quantity columns are no longer empty in exports.
  - All 6 built-in script templates (quantity takeoff, fire-safety check, MEP schedule, envelope check, space validation, data-quality audit) updated to dynamically discover and include relevant property/quantity columns instead of hardcoding minimal attribute lists.

- Updated dependencies [[`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d)]:
  - @ifc-lite/sandbox@1.9.0
  - @ifc-lite/bcf@1.9.0
  - @ifc-lite/cache@1.9.0
  - @ifc-lite/data@1.9.0
  - @ifc-lite/drawing-2d@1.9.0
  - @ifc-lite/encoding@1.9.0
  - @ifc-lite/export@1.9.0
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/ids@1.9.0
  - @ifc-lite/lens@1.9.0
  - @ifc-lite/lists@1.9.0
  - @ifc-lite/mutations@1.9.0
  - @ifc-lite/parser@1.9.0
  - @ifc-lite/query@1.9.0
  - @ifc-lite/renderer@1.9.0
  - @ifc-lite/server-client@1.9.0
  - @ifc-lite/spatial@1.9.0
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Minor Changes

- [#212](https://github.com/louistrue/ifc-lite/pull/212) [`5d4dd1e`](https://github.com/louistrue/ifc-lite/commit/5d4dd1e40539b02af666ef8329c749d708a09e17) Thanks [@louistrue](https://github.com/louistrue)! - Add annotation selection, deletion, move, and text re-editing in 2D drawings

  - Click any annotation (measure, polygon area, text box, cloud) to select it — highlighted with a dashed blue border and corner handles
  - Press Delete/Backspace to remove the selected annotation
  - Drag to reposition any selected annotation
  - Double-click text annotations to re-enter edit mode
  - Escape exits annotation tools back to Select/Pan mode and deselects
  - "Select / Pan" option added to annotation toolbar dropdown
  - Performance: ephemeral drag state uses local refs instead of store updates, stable coordinate callbacks via refs, hit-test reads from storeRef to prevent callback cascade

### Patch Changes

- Updated dependencies [[`7ae9711`](https://github.com/louistrue/ifc-lite/commit/7ae971119ad92c05c521a4931105a9a977ffc667), [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81), [`0b6880a`](https://github.com/louistrue/ifc-lite/commit/0b6880ac9bafee78e8b604e8df5a8e14dc74bc28)]:
  - @ifc-lite/renderer@1.8.0
  - @ifc-lite/lens@1.8.0
  - @ifc-lite/export@1.8.0
  - @ifc-lite/bcf@1.8.0
  - @ifc-lite/cache@1.8.0
  - @ifc-lite/data@1.8.0
  - @ifc-lite/drawing-2d@1.8.0
  - @ifc-lite/encoding@1.8.0
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/ids@1.8.0
  - @ifc-lite/lists@1.8.0
  - @ifc-lite/mutations@1.8.0
  - @ifc-lite/parser@1.8.0
  - @ifc-lite/query@1.8.0
  - @ifc-lite/server-client@1.8.0
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

- [#200](https://github.com/louistrue/ifc-lite/pull/200) [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a) Thanks [@louistrue](https://github.com/louistrue)! - Add schema-aware property editing, full property panel display, and document/relationship support

  - Property editor validates against IFC4 standard (ISO 16739-1:2018): walls get wall psets, doors get door psets, etc.
  - Schema-version-aware property editing: detects IFC2X3/IFC4/IFC4X3 from FILE_SCHEMA header
  - New dialogs for adding classifications (12 standard systems), materials, and quantities in edit mode
  - Quantity set definitions (Qto\_) with schema-aware dialog for standard IFC4 base quantities
  - On-demand classification extraction from IfcRelAssociatesClassification with chain walking
  - On-demand material extraction supporting all IFC material types: IfcMaterial, IfcMaterialLayerSet, IfcMaterialProfileSet, IfcMaterialConstituentSet, IfcMaterialList, and \*Usage wrappers
  - On-demand document extraction from IfcRelAssociatesDocument with DocumentReference→DocumentInformation chain
  - Type-level property merging: properties from IfcTypeObject HasPropertySets merged with instance properties
  - Structural relationship display: openings, fills, groups, and connections
  - Advanced property type parsing: IfcPropertyEnumeratedValue, BoundedValue, ListValue, TableValue, ReferenceValue
  - Georeferencing display (IfcMapConversion + IfcProjectedCRS) in model metadata panel
  - Length unit display in model metadata panel
  - Classifications, materials, documents displayed with dedicated card components
  - Type-level material/classification inheritance via IfcRelDefinesByType
  - Relationship graph fallback for server-loaded models without on-demand maps
  - Cycle detection in material resolution and classification chain walking
  - Removed `any` types from parser production code in favor of proper `PropertyValue` union type

### Patch Changes

- [#202](https://github.com/louistrue/ifc-lite/pull/202) [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c) Thanks [@louistrue](https://github.com/louistrue)! - Fix empty Description, ObjectType, and Tag columns in lists and show all IFC attributes in property panel

  - Lists: add on-demand attribute extraction fallback with per-provider caching for Description, ObjectType, and Tag columns that were previously always empty
  - Property panel: show ALL string/enum IFC attributes dynamically using the schema registry (Name, Description, ObjectType, Tag, PredefinedType, etc.) instead of hardcoding only Name/Description/ObjectType
  - Parser: add `extractAllEntityAttributes()` for schema-aware full attribute extraction, extend `extractEntityAttributesOnDemand()` to include Tag (IfcElement index 7)
  - Query: add `EntityNode.tag` getter and `EntityNode.allAttributes()` method for comprehensive attribute access
  - Performance: cache `getAttributeNames()` inheritance walks, hoist module-level constants
  - Fix type name casing bug where multi-word UPPERCASE STEP types (e.g., IFCWALLSTANDARDCASE) failed schema lookup

- Updated dependencies [[`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658), [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04), [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/encoding@1.7.0
  - @ifc-lite/lists@1.7.0
  - @ifc-lite/renderer@1.7.0
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/query@1.7.0
  - @ifc-lite/data@1.7.0
  - @ifc-lite/cache@1.7.0
  - @ifc-lite/export@1.7.0
  - @ifc-lite/ids@1.7.0
  - @ifc-lite/bcf@1.7.0
  - @ifc-lite/drawing-2d@1.7.0
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/lens@1.7.0
  - @ifc-lite/mutations@1.7.0
  - @ifc-lite/server-client@1.7.0
  - @ifc-lite/spatial@1.7.0
  - @ifc-lite/wasm@1.7.0

## 1.6.0

### Minor Changes

- Initial tracked version
