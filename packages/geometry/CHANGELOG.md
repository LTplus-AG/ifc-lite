# @ifc-lite/geometry

## 2.1.0

### Minor Changes

- [#889](https://github.com/LTplus-AG/ifc-lite/pull/889) [`32c2f01`](https://github.com/LTplus-AG/ifc-lite/commit/32c2f014c668b97247d6cec236e53d1573201662) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcAlignment` as a thin centerline **line** instead of a triangulated
  ribbon, matching how IfcGrid axes and IfcAnnotation curves draw.

  `IfcAlignment` carries its geometry in the `Axis` curve (`IfcAlignmentCurve` or
  `IfcPolyline`), not a `Representation`. Previously the streaming batch mesher
  routed it through the whole-element `IfcAlignmentProcessor`, which sampled the
  directrix into a thin solid ribbon strip — visually wrong for what is a
  centerline. Now the alignment is sampled straight into a line-list overlay:

  - **`@ifc-lite/wasm`** gains `IfcAPI.parseAlignmentLines(content)`, which walks
    every `IfcAlignment`, resolves its `Axis` directrix, samples the centerline
    (1 file-unit station spacing, adaptive cap at 5000 samples) and returns a flat
    `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in the
    renderer's Y-up, RTC-subtracted, metres world space — the same frame the mesh
    pipeline produces, so the line lands on the same ground as the terrain.
  - **`@ifc-lite/geometry`** surfaces it as `GeometryProcessor.parseAlignmentLines`.
  - **`@ifc-lite/renderer`** gains `uploadAlignmentLines3D` / `clearAlignmentLines3D`,
    drawing the centerline through the existing line pipeline (separate buffer).

  The batch mesher no longer special-cases `IfcAlignment` into the ribbon
  processor (reverted to the prior skip), so alignments are lines-only — never
  both. In the viewer the centerline renders whenever a model carries an
  alignment (no toggle).

  Regression coverage: `alignment_lines` unit tests in
  `rust/wasm-bindings/src/api/alignment_lines.rs` pin the contract — a planar
  polyline alignment emits an even-count line-list whose start maps to the
  renderer origin and whose extent matches the directrix, and a file with no
  alignment emits an empty array.

### Patch Changes

- Updated dependencies [[`175f8e3`](https://github.com/LTplus-AG/ifc-lite/commit/175f8e3ed93acba35f2efcb57993dd137ff7a241), [`32c2f01`](https://github.com/LTplus-AG/ifc-lite/commit/32c2f014c668b97247d6cec236e53d1573201662)]:
  - @ifc-lite/wasm@2.1.0

## 2.0.0

### Major Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/data@2.0.0

## 1.19.0

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

## 1.18.5

### Patch Changes

- [#679](https://github.com/louistrue/ifc-lite/pull/679) [`a376179`](https://github.com/louistrue/ifc-lite/commit/a376179aa40e3f8f8550cd449fd114d5f4939217) Thanks [@louistrue](https://github.com/louistrue)! - Fix consumer build failure when bundling `@ifc-lite/geometry` without
  `@ifc-lite/wasm-threaded` installed (issue #676). The published
  `dist/geometry-controller.worker.js` used to carry a static
  `import init, { initSync, IfcAPI, initThreadPool } from '@ifc-lite/wasm-threaded'`
  which Turbopack / webpack / Vite all follow during worker chunking —
  the optional peer-dep flag added in #665 only suppresses `pnpm install`
  warnings, not bundler resolution. Consumers on Next 16 + Turbopack hit
  `Module not found: Can't resolve '@ifc-lite/wasm-threaded'`.

  The threaded bundle is intentionally workspace-only (see
  `packages/wasm-threaded/package.json` `_intent`; the production path
  uses the single-threaded `@ifc-lite/wasm` and the controller is kept as
  latent infrastructure per
  `docs/architecture/single-controller-rayon-design.md` §12). Resolution
  splits across build steps:

  - **Source** keeps the static `import … from '@ifc-lite/wasm-threaded'`
    so the workspace build (Vite alias →
    `packages/wasm-threaded/pkg/ifc-lite.js`) still resolves the
    controller-path opt-in correctly. Vite only honors aliases for
    statically-analyzable specifiers, and the viewer toggles the
    controller path via `localStorage['ifc-lite:single-controller']='1'`.
  - **Published dist** is post-processed by
    `scripts/transform-controller-worker-dist.mjs` after `tsc`. The
    transform replaces the static line with module-level `let` bindings
    plus a lazy `await import(<runtime-built-specifier>)` loader, and
    injects an `await __loadThreadedModule()` at the top of the `init`
    handler. Consumer bundlers no longer see `@ifc-lite/wasm-threaded` as
    a build-time dependency.

  A new `geometry-controller-dist.test.ts` regression test pins both
  halves of the contract — no static import in dist, and the lazy loader
  is present.

## 1.18.4

### Patch Changes

- [#672](https://github.com/louistrue/ifc-lite/pull/672) [`d24466f`](https://github.com/louistrue/ifc-lite/commit/d24466fb7d2ab754ae105981113fe3d5bb67c9e8) Thanks [@louistrue](https://github.com/louistrue)! - Document the Vite `worker.format: 'es'` config requirement (the actual
  root cause of #666 for geometry consumers — ESM workers are not Vite's
  default and the package can't ship around that) and add an optional
  `ProcessParallelOptions.wasmUrls` escape hatch so consumers whose
  bundler doesn't transform `new URL('ifc-lite_bg.wasm', import.meta.url)`
  inside the worker — or who serve the wasm from a different origin
  (CDN, Tauri custom protocol, etc.) — can pass an explicit URL. The
  workers forward it to wasm-bindgen's documented `init(url)` parameter.
  Default behaviour is unchanged: Vite + webpack 5 consumers who already
  worked continue to work without setting `wasmUrls`.

## 1.18.3

### Patch Changes

- [#667](https://github.com/louistrue/ifc-lite/pull/667) [`8048ee4`](https://github.com/louistrue/ifc-lite/commit/8048ee411d770255c3e6fcf6a5d9f0369dc16b2f) Thanks [@louistrue](https://github.com/louistrue)! - Drop runtime dependency on the private `@ifc-lite/wasm-threaded` workspace package. Previously published `@ifc-lite/geometry` manifests pointed at `@ifc-lite/wasm-threaded@0.1.0`, which is intentionally non-publishable, causing `npm install @ifc-lite/geometry` to fail. The threaded bundle is only imported by the single-controller worker behind a feature flag and is always supplied via a host bundler alias, so it now lives in `devDependencies` with an optional `peerDependency` documenting the alias contract.

## 1.18.2

### Patch Changes

- [#656](https://github.com/louistrue/ifc-lite/pull/656) [`384efaa`](https://github.com/louistrue/ifc-lite/commit/384efaaaee45cd6f36d3a107899b3b4106143c9a) Thanks [@maxkrut](https://github.com/maxkrut)! - Reject overlapping WASM streaming geometry runs with a controlled JavaScript error before re-entering the processor.

- [#633](https://github.com/louistrue/ifc-lite/pull/633) [`7b70805`](https://github.com/louistrue/ifc-lite/commit/7b70805632627a6e4351b1735479be18390c8b21) Thanks [@maxkrut](https://github.com/maxkrut)! - Fix published worker URLs to reference the emitted JavaScript file.

  `@ifc-lite/geometry` starts parallel geometry processing by constructing
  module workers from `geometry-parallel`. The published npm package includes
  `dist/geometry.worker.js`, but `dist/geometry-parallel.js` still points at
  `./geometry.worker.ts`, so consumers can fail to load the worker at runtime.

  Keep source worker URLs pointing at TypeScript files for in-repo Vite builds,
  and extend the post-build rewrite so published `dist/index.js` and
  `dist/geometry-parallel.js` point at the emitted JavaScript worker files.

## 1.18.1

### Patch Changes

- [#644](https://github.com/louistrue/ifc-lite/pull/644) [`6f052c3`](https://github.com/louistrue/ifc-lite/commit/6f052c309a99edd1d9a6925d44bbc2aed6cd10a5) Thanks [@louistrue](https://github.com/louistrue)! - Add "Merge Multilayer Walls" load-time toggle (issue #540).

  When enabled, every `IfcBuildingElementPart` whose `IfcRelAggregates`
  parent wall (a) has its own `Representation` and (b) is sliceable in
  `MaterialLayerIndex` is suppressed during geometry emission. The parent
  wall's single swept solid keeps the per-layer sub-mesh colouring via the
  existing slicer, so the visual result on multilayer walls is the same as
  the layered render — but with one mesh per wall instead of N per-layer
  parts. Designed for large Revit-exported models where the per-layer
  extrusions inflate vertex counts beyond what the viewer can handle.

  New JS surface on `IfcAPI`:

  ```ts
  setMergeLayers(enabled: boolean): void
  ```

  Defaults to `false`. Honoured by `parseMeshes`, `parseMeshesSubset`,
  `parseMeshesAsync`, `parseMeshesInstanced`, `parseMeshesInstancedAsync`,
  `processGeometryBatch`, and `processGeometryBatchParallel`. The batch
  paths cache the parts-to-skip set on `IfcAPI` so workers build it once
  per content and reuse across every batch; the cache is cleared by
  `clearPrePassCache` and by `setMergeLayers`.

  Voids stay correct: `propagate_voids_to_parts` already copies the
  parent wall's `IfcRelVoidsElement` references onto its layer parts in
  the same pass that builds the part → parent map, so windows and doors
  still cut through the merged solid.

- Updated dependencies [[`1d6e99b`](https://github.com/louistrue/ifc-lite/commit/1d6e99bb23f67e20a192f362ba65ee73a8180f69), [`b6e83d3`](https://github.com/louistrue/ifc-lite/commit/b6e83d3ac4f04fe7c439bf282a25963c6db0b909), [`6f052c3`](https://github.com/louistrue/ifc-lite/commit/6f052c309a99edd1d9a6925d44bbc2aed6cd10a5), [`b8a8206`](https://github.com/louistrue/ifc-lite/commit/b8a82062c4392d05224561dda8a2767a8b7b1857)]:
  - @ifc-lite/wasm@1.16.10

## 1.18.0

### Minor Changes

- [#629](https://github.com/louistrue/ifc-lite/pull/629) [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599) Thanks [@louistrue](https://github.com/louistrue)! - **Parse IFC off the main thread.** The browser viewer now runs `IfcParser.parseColumnar`
  inside a dedicated `WorkerParser` worker that shares the source bytes via
  `SharedArrayBuffer` with the existing geometry workers. Parse and geometry
  streaming run in parallel without contending for main-thread time, cutting
  upload-to-interactive wall-clock by roughly 2× on medium-to-large files.

  New public APIs:

  - `@ifc-lite/parser`

    - `WorkerParser` (browser-only, exported from `@ifc-lite/parser/browser`)
    - `data-store-transport`: `toTransport(store)` / `fromTransport(payload, source)`
      plus the `DataStoreTransport` payload type. Lets any consumer ship a
      fully-typed `IfcDataStore` across a `postMessage` boundary with the
      typed-array buffers in the transfer list and closures rebuilt on receipt.

  - `@ifc-lite/data`

    - `entityTableFromColumns` / `entityTableToColumns`
    - `propertyTableFromColumns` / `propertyTableToColumns`
    - `quantityTableFromColumns` / `quantityTableToColumns`
    - `relationshipGraphFromColumns` / `relationshipGraphToColumns`
    - `relationshipEdgesFromColumns`, `relationshipGraphFromEdges`, `buildCSR`
    - `StringTable.fromArray(strings)`
    - `EntityTable.rawTypeName` is now exposed (optional column) so the
      unknown-type display fallback round-trips through column transports.

  - `@ifc-lite/geometry`

    - `processParallel(buffer, coordinator, sharedRtcOffset?, existingSab?, options?)`:
      `existingSab` lets the geometry workers reuse a SAB the caller already
      populated. The new fifth argument is `ProcessParallelOptions` with:
      - `onEntityIndex(ids, starts, lengths)`: invoked once the streaming
        pre-pass has built the entity index. Hosts forward the SAB-shared
        columns to `WorkerParser.setEntityIndex(...)` so the parser skips
        its own ~10 s WASM scan.
      - `useSingleController`: opt-in (off by default) to the experimental
        single-controller + wasm-bindgen-rayon path. See
        `docs/architecture/single-controller-rayon-design.md` §12 for the
        post-mortem on when this helps and when it regresses.
    - `GeometryProcessor.processParallel` and `processAdaptive` accept the
      same options to plumb them through.
    - `StreamingGeometryEvent` gains a `workerMemory` variant carrying
      per-worker WASM heap + mesh-byte counts for memory accounting.

  - `@ifc-lite/parser` (additions on top of the worker entry above)
    - `WorkerParser.setEntityIndex(ids, starts, lengths)`: hand a pre-built
      entity index to the worker's `IfcAPI`. Pairs with the geometry
      pre-pass's `onEntityIndex` callback above.
    - `WorkerParserOptions.waitForEntityIndex`: when true, the worker blocks
      its WASM scan until `setEntityIndex` arrives (60 s watchdog falls
      back to the regular scan if it never does).
    - `IfcParser.parseColumnar`: signature widened to accept
      `ArrayBuffer | SharedArrayBuffer` (was `ArrayBuffer`); the SAB-backed
      parser worker no longer needs an `as unknown as ArrayBuffer` cast.

  The viewer auto-falls back to the in-process `IfcParser` when
  `crossOriginIsolated` is `false` or the worker spawn throws, so behavior is
  unchanged in environments without SAB.

### Patch Changes

- [#637](https://github.com/louistrue/ifc-lite/pull/637) [`2334993`](https://github.com/louistrue/ifc-lite/commit/2334993827839b9f5b96ca8008c49543fb597660) Thanks [@louistrue](https://github.com/louistrue)! - Fix `Could not resolve entry module "geometry.worker.ts"` when bundling the
  published `@ifc-lite/geometry` package with Vite/Rollup.

  `src/geometry-parallel.ts` constructs module workers via
  `new Worker(new URL('./geometry.worker.ts', import.meta.url), ...)`. The post-
  build step in `package.json` rewrites those `.ts` URLs to `.js` so the npm
  tarball ships URLs that point at the emitted file — but the rewrite was only
  applied to `dist/index.js`, and the worker URLs live in `dist/geometry-parallel.js`.
  Consumers like the `create-ifc-lite` Vite templates therefore tried to load a
  `.ts` worker entry that is not present in the tarball and the build failed.

  Apply the rewrite to every `.js` file in `dist/`, leaving the source TypeScript
  URL unchanged so in-repo Vite builds keep resolving the worker from source.

- [#641](https://github.com/louistrue/ifc-lite/pull/641) [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815) Thanks [@louistrue](https://github.com/louistrue)! - Fix `IfcReinforcingBar` stirrup rendering (issue #631, sample
  `IfcReinforcingBar.ifc`).

  `IfcSweptDiskSolid` directrixes that use `IfcIndexedPolyCurve` over
  `IfcCartesianPointList3D` (typical for stirrups and other bent rebar that
  lives outside the XY plane) used to fall back to a 2D parser that read x/y
  from indices 0–1 and silently dropped the Z coordinate. The stirrup
  collapsed onto z=0 and the resulting tube was a flat near-degenerate line.

  The 3D curve dispatcher now has a native arm for `IfcIndexedPolyCurve` that
  reads `IfcCartesianPointList2D` (z=0) or `IfcCartesianPointList3D` verbatim
  and fits `IfcArcIndex` segments using a circumcircle in the plane of their
  three control points. Straight schema conformance — no spec deviation.

  The second sample on the issue (`Rebar2.ifc`) was already rendering its
  directrix correctly under the existing segment-index trim path; no change
  needed there.

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/data@1.17.0

## 1.17.1

### Patch Changes

- [#630](https://github.com/louistrue/ifc-lite/pull/630) [`5439cce`](https://github.com/louistrue/ifc-lite/commit/5439cce34edaff1c050ce8975a330163167df6fd) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcExtrudedAreaSolidTapered` (issue #628).

  Tapered extrusions (e.g. beams or columns whose cross-section transitions
  between a `SweptArea` profile at the base and an `EndSweptArea` profile at
  `Depth`) were recognised by the parser but silently skipped by the geometry
  engine, so the elements never appeared in the viewer.

  The Rust geometry crate now ships:

  - `extrude_profile_lofted` in `extrusion.rs` — generates caps from each
    profile's own triangulation and stitches the side walls 1:1, resampling
    the shorter outer loop by arc length when authoring tools emit profiles
    with mismatched vertex counts. Side normals are computed from the actual
    3D quad so sloped faces shade correctly.
  - `ExtrudedAreaSolidTaperedProcessor` registered alongside the existing
    `ExtrudedAreaSolidProcessor`. Falls back to a uniform extrusion if
    `EndSweptArea` is missing so malformed files still render.
  - `IfcExtrudedAreaSolidTapered` is now accepted by `profile_extractor`
    (used by 2D drawing projection) and the `IfcMappedItem` dispatcher.

  Out of scope for this patch and called out for follow-up:
  `IfcRevolvedAreaSolidTapered`, plus tapered solids participating in
  `IfcBooleanClippingResult` / openings / material-layer slicing.

- Updated dependencies [[`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43)]:
  - @ifc-lite/data@1.16.0

## 1.17.0

### Minor Changes

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

### Patch Changes

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

## 1.16.6

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

- Updated dependencies [[`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/wasm@1.16.7

## 1.16.5

### Patch Changes

- [#519](https://github.com/louistrue/ifc-lite/pull/519) [`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b) Thanks [@louistrue](https://github.com/louistrue)! - Fix geometry processing hang on models with 500K+ geometry elements

  Cache entity index from buildPrePassOnce and reuse it across processGeometryBatch calls, eliminating redundant full-file scans. Cap batch count at 30 to prevent excessive per-batch overhead for models with very high geometry element counts.

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b)]:
  - @ifc-lite/wasm@1.16.4

## 1.16.4

### Patch Changes

- [#503](https://github.com/louistrue/ifc-lite/pull/503) [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc) Thanks [@louistrue](https://github.com/louistrue)! - Improve the native geometry bridge so desktop/native streaming emits the same incremental mesh contract as the web viewer, including IFC type metadata on native batches.

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Support color-merged GPU batches with per-vertex entityIds, reduce desktop native streaming overhead, and remove debug console statements.

- [#503](https://github.com/louistrue/ifc-lite/pull/503) [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc) Thanks [@louistrue](https://github.com/louistrue)! - Add native desktop streaming telemetry hooks so sibling desktop loads can capture Rust-to-JS first-batch timings and write structured benchmark reports without changing the viewer mesh contract.

- [#503](https://github.com/louistrue/ifc-lite/pull/503) [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc) Thanks [@louistrue](https://github.com/louistrue)! - Add a native desktop file-path geometry streaming path so very large IFC files do not need to be copied through browser memory and Tauri IPC before processing.

- Updated dependencies [[`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e)]:
  - @ifc-lite/wasm@1.16.3

## 1.16.3

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

- [#502](https://github.com/louistrue/ifc-lite/pull/502) [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b) Thanks [@louistrue](https://github.com/louistrue)! - Fix large direct `GeometryProcessor.processStreaming()` and `processInstancedStreaming()` calls by switching oversized IFC inputs to the existing byte-based WASM pre-pass and batch pipeline instead of decoding the entire file into a single JavaScript string first, and expose the supporting byte-based instanced batch API from `@ifc-lite/wasm`.

- Updated dependencies [[`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b), [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/wasm@1.16.2
  - @ifc-lite/data@1.15.2

## 1.16.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4), [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/wasm@1.16.1
  - @ifc-lite/data@1.15.1

## 1.16.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0

## 1.16.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/wasm@1.16.0

## 1.15.0

### Minor Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Add Web Worker parallel geometry processing. Pre-pass runs once on a dedicated worker, then geometry is split across multiple workers using SharedArrayBuffer for zero-copy file sharing. Disable wasm-bindgen-rayon initThreadPool (incompatible with Vite production builds). Switch from async streaming to optimized single-call processing for maximum throughput.

### Patch Changes

- Updated dependencies [[`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6)]:
  - @ifc-lite/wasm@1.15.0

## 1.14.4

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- [#412](https://github.com/louistrue/ifc-lite/pull/412) [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd) Thanks [@louistrue](https://github.com/louistrue)! - Refactor void clipping helpers, material styling, and submesh color resolution for improved readability and maintainability.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515), [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd)]:
  - @ifc-lite/data@1.14.5
  - @ifc-lite/wasm@1.14.5

## 1.14.3

### Patch Changes

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Fix sandbox creator/session isolation, sandbox lifecycle races, and geometry crash recovery messaging.

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45)]:
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/data@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/wasm@1.14.1
  - @ifc-lite/data@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- [#250](https://github.com/louistrue/ifc-lite/pull/250) [`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437) Thanks [@louistrue](https://github.com/louistrue)! - Declare `@ifc-lite/data` as a runtime dependency.

  The package already imported `createLogger` from `@ifc-lite/data` but did not list
  it in `dependencies`, causing resolution failures for consumers installing from npm.

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies [[`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/wasm@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/wasm@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/wasm@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies []:
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
  - @ifc-lite/wasm@1.5.0

## 1.3.0

### Minor Changes

- [#139](https://github.com/louistrue/ifc-lite/pull/139) [`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857) Thanks [@louistrue](https://github.com/louistrue)! - Add PolygonalFaceSetProcessor and surface model processors for improved geometry support

  ### New Geometry Processors

  - **PolygonalFaceSetProcessor**: Handle IfcPolygonalFaceSet with triangulation of arbitrary polygons
  - **FaceBasedSurfaceModelProcessor**: Process IfcFaceBasedSurfaceModel geometry
  - **SurfaceOfLinearExtrusionProcessor**: Handle IfcSurfaceOfLinearExtrusion surfaces
  - **ShellBasedSurfaceModelProcessor**: Process IfcShellBasedSurfaceModel geometry

  ### Performance Optimizations

  - Add fast-path decoder functions with point caching for BREP-heavy files (~2x faster)
  - Add `get_first_entity_ref_fast`, `get_polyloop_coords_fast`, `get_polyloop_coords_cached`
  - Add `has_non_null_attribute()` for fast attribute filtering
  - Optimize FacetedBrep with fast-path using `get_face_bound_fast`
  - Add WASM-specific sequential iteration to avoid threading overhead

- [#135](https://github.com/louistrue/ifc-lite/pull/135) [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e) Thanks [@louistrue](https://github.com/louistrue)! - Fix RTC (Relative To Center) coordinate handling consistency

  **BREAKING**: Rename `isGeoReferenced` to `hasLargeCoordinates` in CoordinateInfo interface.
  Large coordinates do NOT mean a model is georeferenced. Proper georeferencing uses IfcMapConversion.

  - Rename isGeoReferenced → hasLargeCoordinates across all packages (geometry, cache, export, viewer)
  - Fix transform_mesh to apply RTC uniformly per-mesh (not per-vertex) preventing mixed coordinates
  - Fix coordinate-handler.ts threshold consistency between bounds calculation and vertex cleanup
  - Fix streaming path originalBounds reconstruction by undoing server-applied shift
  - Surface RTC offset in GpuGeometry struct with JS-accessible getters (rtcOffsetX/Y/Z, hasRtcOffset)
  - Add RTC detection and offset handling to parseToGpuGeometryAsync
  - Include RTC offset in GPU async completion stats
  - Add comprehensive coordinate handling documentation

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

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

- Updated dependencies [[`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857), [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490), [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e)]:
  - @ifc-lite/wasm@1.3.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

## 1.2.0

### Minor Changes

- f4fbf8c: ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

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

- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies
- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies [ed8f77b]
- Updated dependencies
- Updated dependencies [f7133a3]
  - @ifc-lite/wasm@1.2.0

## 1.2.0

### Minor Changes

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **2D Profile-Level Boolean Operations**: Implemented efficient 2D polygon boolean operations for void subtraction at the profile level before extrusion. This provides 10-25x performance improvement over 3D CSG operations for most openings and produces cleaner geometry with fewer degenerate triangles.

  - **Void Analysis and Classification**: Added intelligent void classification system that distinguishes between coplanar voids (can be handled efficiently in 2D) and non-planar voids (require 3D CSG). This enables optimal processing strategy selection.

  - **Enhanced Void Handling**: Improved void subtraction in extrusions with support for both full-depth and partial-depth voids, including segmented extrusion for complex void configurations.

  ### Improvements

  - **WASM Compatibility**: Replaced `clipper2` (C++ dependency) with `i_overlay` (pure Rust) for WASM builds, eliminating C++ compilation issues and ensuring reliable WASM builds.

  - **Performance**: Profile-level void subtraction is significantly faster than 3D CSG operations, especially for floors/slabs with many penetrations.

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

- Updated dependencies [[`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff)]:
  - @ifc-lite/wasm@1.2.0
