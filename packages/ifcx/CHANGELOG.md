# @ifc-lite/ifcx

## 2.3.1

### Patch Changes

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`7dcf3e1`](https://github.com/LTplus-AG/ifc-lite/commit/7dcf3e1e33101c694f0acc74aa77cf07770c63c5), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90)]:
  - @ifc-lite/data@2.7.0
  - @ifc-lite/mutations@1.21.0
  - @ifc-lite/pointcloud@0.4.0

## 2.3.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline ([#1031](https://github.com/LTplus-AG/ifc-lite/issues/1031)): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486)]:
  - @ifc-lite/mutations@1.19.0

## 2.2.3

### Patch Changes

- [#1699](https://github.com/LTplus-AG/ifc-lite/pull/1699) [`ec53138`](https://github.com/LTplus-AG/ifc-lite/commit/ec53138f252578253b55e1caf28a23dc9cc61de9) Thanks [@louistrue](https://github.com/louistrue)! - IFC5 system membership reaches the viewer's Groups tab: the ifcx composer now
  emits AssignsToGroup relationship edges from the `bsi::ifc::system::partofsystem`
  attribute (group -> member, matching STEP direction), and the on-demand group
  member/relationship extractors fall back to the EntityTable when a store has no
  STEP byte-span index (IFCX stores ingest with an empty entityIndex.byId).

## 2.2.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/mutations@1.18.1
  - @ifc-lite/pointcloud@0.3.5

## 2.2.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/pointcloud@0.3.4

## 2.2.0

### Minor Changes

- [#1642](https://github.com/LTplus-AG/ifc-lite/pull/1642) [`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d) Thanks [@louistrue](https://github.com/louistrue)! - Carry a spatial node's IFC `LongName` through the hierarchy so the spatial structure can show both the short code and the descriptive label, e.g. "01" + "Main Residence" (issue [#1634](https://github.com/LTplus-AG/ifc-lite/issues/1634)):

  - `@ifc-lite/data`: `SpatialNode` gains an optional `longName?: string` (the descriptive name, kept only when present and distinct from `name`). Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/parser`: `SpatialHierarchyBuilder` now reads `LongName` off the source record by schema attribute _name_ and populates `SpatialNode.longName`. Resolving by name (not a fixed index) keeps it correct across the IfcRoot family, since `IfcProject` carries `LongName` at a different index than the `IfcSpatialStructureElement` subtypes; the lookup spans the bundled schema union (2X3 + 4 + 4X3) via the new `getAttributeNamesAcrossSchemas`, so IFC4.3 facility/infra containers (`IfcFacility`, `IfcBridge`, `IfcRoad`, …) outside the parser's IFC4 codegen pin resolve too. When `Name` is empty it falls back to `LongName` for the primary label. The source-less `buildFromCache` path leaves it undefined, exactly like storey elevation. `data-store-transport` serializes the new field so the worker→main transfer preserves it.
  - `@ifc-lite/ifcx`: the IFCX/IFC5 hierarchy builder populates `SpatialNode.longName` from `bsi::ifc::prop::LongName` for parity.

### Patch Changes

- Updated dependencies [[`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d)]:
  - @ifc-lite/data@2.5.0

## 2.1.6

### Patch Changes

- [#1506](https://github.com/LTplus-AG/ifc-lite/pull/1506) [`796f50a`](https://github.com/LTplus-AG/ifc-lite/commit/796f50a3b0072dd2c07b60ef84e3f1d2996444e2) Thanks [@louistrue](https://github.com/louistrue)! - fix(ifcx): guard PathIndex hierarchical indexing against child cycles

  `PathIndex.indexHierarchicalPaths` recursed through a node's children with no
  ancestor tracking, so a malformed IFCX layer with a child cycle (`A -> B -> A`)
  recursed until the stack overflowed and crashed the load. The recursion now
  tracks the uuids on the current DFS branch and skips a child that is already an
  ancestor; a node reached by two distinct non-ancestral paths (a diamond) is
  still indexed under both.

- Updated dependencies [[`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229)]:
  - @ifc-lite/data@2.3.0

## 2.1.5

### Patch Changes

- [#1047](https://github.com/LTplus-AG/ifc-lite/pull/1047) [`71c3e92`](https://github.com/LTplus-AG/ifc-lite/commit/71c3e92bae778fe7e5c34d9fcce5abfbd4f3ede5) Thanks [@louistrue](https://github.com/louistrue)! - fix(ifcx): stop duplicating geometry for entities with multiple incoming
  containment edges. A node reachable through more than one parent (e.g. a
  wall hanging under both its storey and a space boundary, as the IFC5
  exporter legitimately emits) was traversed once per incoming edge and its
  mesh emitted each time — an export round-trip multiplied per-entity
  triangle counts by the number of edges (Hello Wall: ×4). Extraction now
  deduplicates per (node path, entity context, accumulated transform), so
  aliased containment edges emit once while shared type bodies referenced
  from multiple instances and genuine instancing still emit per context.

## 2.1.4

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/pointcloud@0.3.3

## 2.1.3

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/data@2.0.1
  - @ifc-lite/pointcloud@0.3.2

## 2.1.2

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/data@2.0.0
  - @ifc-lite/mutations@1.15.1

## 2.1.1

### Patch Changes

- Updated dependencies [[`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e)]:
  - @ifc-lite/data@1.17.0
  - @ifc-lite/pointcloud@0.3.0

## 2.1.0

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

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/pointcloud@0.2.0

## 2.0.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/mutations@1.14.5

## 2.0.1

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

## 2.0.0

### Major Changes

- [#336](https://github.com/louistrue/ifc-lite/pull/336) [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5) Thanks [@louistrue](https://github.com/louistrue)! - Remove the legacy single-parent `ComposedNode.parent` field and `getPathToRoot()` export from the IFCX composition API. IFCX extraction now relies on explicit traversal frames instead of mutable parent pointers, and the build now verifies built `dist` output against the Hello Wall IFCX fixtures.

### Patch Changes

- [#336](https://github.com/louistrue/ifc-lite/pull/336) [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFCX inherited geometry mapping so window instances render geometry inherited from IfcWindow types.

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/data@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/mutations@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.1
  - @ifc-lite/mutations@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/mutations@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/mutations@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/mutations@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/mutations@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/mutations@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/mutations@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/mutations@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/mutations@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/mutations@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [[`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/data@1.7.0
  - @ifc-lite/mutations@1.7.0

## 1.6.0

### Minor Changes

- [#163](https://github.com/louistrue/ifc-lite/pull/163) [`95a96cb`](https://github.com/louistrue/ifc-lite/commit/95a96cb41b79253697a20380dbbae1450ee4c55a) Thanks [@github-actions](https://github.com/apps/github-actions)! - Add GLB file import support for fast geometry loading and 3D tool interoperability

  - Add GLB parser (parseGLB, loadGLBToMeshData) to cache package for importing pre-cached geometry
  - Enable round-trip workflows: IFC → GLB (export) → MeshData (import)
  - Support GLB files in viewer: upload, drag-and-drop, and multi-model federation
  - Detect GLB format via magic bytes (0x46546C67)

## 1.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3)]:
  - @ifc-lite/data@1.3.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

## 1.2.0

### Minor Changes

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

## 1.2.0

### Minor Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility
