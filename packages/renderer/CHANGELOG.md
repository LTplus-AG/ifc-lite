# @ifc-lite/renderer

## 1.39.0

### Minor Changes

- [#1793](https://github.com/LTplus-AG/ifc-lite/pull/1793) [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4 `IfcImageTexture` surface textures from `.ifcZIP` containers ([#1781](https://github.com/LTplus-AG/ifc-lite/issues/1781)).

  - parser: new `unwrapIfcZipWithResources` surfaces sibling raster images (the files `IfcImageTexture.URLReference` points at) alongside the model entry, keyed by lowercased basename; `unwrapIfcZip` is unchanged.
  - geometry/wasm: `IfcImageTexture` now resolves to a lightweight reference (`textureId` = the `IfcSurfaceTexture` express id, URL, repeat flags) instead of being dropped — the host decodes the image once per id, so a 4096² JPEG shared by dozens of face sets is decoded and uploaded exactly once. `IfcIndexedTriangleTextureMap` with a null `TexCoordIndex` (the SketchUp IFC Manager export shape) now maps UVs 1:1 with the face set's coordinates per spec. Textured face sets on ORDINARY occurrences (direct `Body` items, not just type-product representation maps) now carry UVs + texture through the sub-mesh path, and blob/pixel texture decodes are Arc-shared instead of cloned per face set.
  - renderer: textured meshes with an external image reference render through the existing WebGPU textured pipeline via a refcounted shared-texture registry (one GPU texture per `textureId`, uploaded from the viewer-decoded `ImageBitmap`); per-mesh [#961](https://github.com/LTplus-AG/ifc-lite/issues/961) blob/pixel uploads are unchanged.
  - viewer: `.ifcZIP` loads decode sibling images with `createImageBitmap` and attach them to arriving meshes; textured models skip the binary geometry cache (which cannot persist textures yet) instead of silently losing textures on the second open.

- [#1789](https://github.com/LTplus-AG/ifc-lite/pull/1789) [`7dcf3e1`](https://github.com/LTplus-AG/ifc-lite/commit/7dcf3e1e33101c694f0acc74aa77cf07770c63c5) Thanks [@louistrue](https://github.com/louistrue)! - Point cloud classification toggles ([#1783](https://github.com/LTplus-AG/ifc-lite/issues/1783)). `@ifc-lite/pointcloud` now aggregates a per-class point histogram during streaming decode (`streamPointCloud`'s `onComplete` gains a `classCounts` argument) and exports the ASPRS class-name table plus aggregation helpers (`lasClassificationName`, `createClassificationCounts`, `accumulateClassificationCounts`, `classificationCountEntries`). `@ifc-lite/renderer` extends the splat shader's class-visibility mask from 32 bits to the full 256-bit LAS code range, so user-defined classes (64-255) can be hidden too; `PointCloudRenderOptions.classMask` accepts either the legacy 32-bit number or up to 8 mask words.

### Patch Changes

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`90522d2`](https://github.com/LTplus-AG/ifc-lite/commit/90522d218d5a9c4df0760349b5bfc60916a23f8f), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`502bdbf`](https://github.com/LTplus-AG/ifc-lite/commit/502bdbf5c4c4c86999f4e662b71ee5b0b16307ae)]:
  - @ifc-lite/geometry@3.3.0

## 1.38.1

### Patch Changes

- [#1775](https://github.com/LTplus-AG/ifc-lite/pull/1775) [`0a1c500`](https://github.com/LTplus-AG/ifc-lite/commit/0a1c500adfd7894b9f1a3f01cc774226b2bdb84b) Thanks [@louistrue](https://github.com/louistrue)! - Fix GPU memory + validation-scope leaks in the WebGPU renderer.

  - Partial sub-batch clones built during hide/isolate are now released when the filter returns to fully-visible (`Scene.dropAllPartialCaches`), instead of staying resident (~2x model VRAM) until the next model reload.
  - Hydrated pick/selection individual meshes are freed on selection change (`Scene.disposeHydratedMeshesExcept`), so they no longer accumulate in VRAM or double-alpha-blend transparent geometry (glass darkening) over their batch copy. Disposal is keyed by the (modelIndex, expressId) pair, so selecting the same express id in a different federated model frees the previous model's mesh too.
  - Per-frame O(total-element-count) work under hide/isolate is cached by a visibility-version epoch: per-batch visibility + visible-id sets are computed once per visibility change, and `getOrCreatePartialBatch` skips its per-frame sort + FNV hash on a cache hit. Change detection is by set CONTENT (not reference), so callers that mutate the same `hiddenIds`/`isolatedIds` Set in place stay correct, and a fresh Set with identical content does not force a cache rebuild; the instanced-occurrence visibility path uses the same contract.
  - Every `pushErrorScope('validation')` is now balanced by a `popErrorScope` on all render paths (null current-texture early-return and thrown frames included), so a leaked scope no longer silently swallows later validation errors and blinds `getDiagnostics().gpuErrors`.
  - `Renderer.destroy()` now calls `GPUDevice.destroy()`, so apps that recreate a renderer per model no longer leak the device/queue/context (the lost-handler already ignores the intentional `'destroyed'` reason).

- Updated dependencies [[`a42b8a9`](https://github.com/LTplus-AG/ifc-lite/commit/a42b8a9cfc559781575dde893b2116a5dc493732)]:
  - @ifc-lite/geometry@3.2.1

## 1.38.0

### Minor Changes

- [#1747](https://github.com/LTplus-AG/ifc-lite/pull/1747) [`01b8b41`](https://github.com/LTplus-AG/ifc-lite/commit/01b8b414bfb72f1893c0c4296153e8f35e44b641) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Add `Renderer.onDeviceLost` so hosts can recover from a lost GPU device instead of a permanently blank canvas.

  When the GPU device is lost for a non-intentional reason — e.g. a Windows TDR driver reset or VRAM exhaustion while rotating/re-opening a large model on a weak or integrated GPU — every pipeline and buffer created from it is dead and the viewport can never present again. Previously the renderer only logged a warning and kept trying to configure the lost device, leaving a permanently blank canvas until a full reload.

  The renderer now:

  - Distinguishes a real loss from an intentional teardown (`GPUDeviceLostInfo.reason === 'destroyed'`) and only reacts to the former.
  - Exposes `Renderer.onDeviceLost(listener)` (returns an unsubscribe) and `Renderer.isDeviceLost()`. Hosts subscribe and typically respond by disposing the renderer and reloading the model. Camera and model state are CPU-side and survive the loss, so the reload restores the model at its current orientation.
  - Makes `render()` a no-op after a loss instead of emitting a stream of GPU validation errors.

## 1.37.0

### Minor Changes

- [#1714](https://github.com/LTplus-AG/ifc-lite/pull/1714) [`9689ea5`](https://github.com/LTplus-AG/ifc-lite/commit/9689ea5276cc107895be56aa9267a4b7b778de2d) Thanks [@louistrue](https://github.com/louistrue)! - Cull GPU-instanced template draws (frustum + contribution) and report instanced frame stats.

  The instanced pass previously drew every template unconditionally — on CATIA-class models that is ~97% of all draw calls (e.g. 8,929 of 9,213), which made orbiting choppy. Each template now carries cull metadata built at shard-upload time (union of occurrence world AABBs + largest single-occurrence bounding-sphere radius): templates are frustum-culled against the union box, and contribution-culled when even the largest occurrence projected at the union box's nearest view depth falls below the active pixel threshold — a conservative upper bound that works for bolts-scattered-everywhere templates whose union box is model-sized. Templates with a selected occurrence are exempt from contribution culling; non-finite occurrence matrices poison a template's metadata so it fails open (never culled); Exploded-mode translates grow the union so moved occurrences can't be culled by pre-move bounds. `FrameStats` gains `instancedDrawn` / `instancedFrustumCulled` / `instancedContributionCulled`.

  Measured on an 883 MB CATIA model: draw calls 9,213 → 2,122 and fast-orbit frame rate 25.5 → 58.4 FPS, with unchanged GPU residency.

### Patch Changes

- [#1716](https://github.com/LTplus-AG/ifc-lite/pull/1716) [`62b68c0`](https://github.com/LTplus-AG/ifc-lite/commit/62b68c06347aab661c3d9417bcf016e565e2c4b1) Thanks [@louistrue](https://github.com/louistrue)! - Add `Scene.getInstancedEntityCount()` (O(1)) so size heuristics — like the viewer's orbit-pivot raycast skip — can account for GPU-instanced entities. On instanced-heavy CATIA-class models the flat mesh/batch census reads deceptively small, and the first pointer-down pivot raycast then materializes tens of thousands of occurrences and builds a BVH over millions of triangles, a visible input-to-first-orbit-frame stall.

- Updated dependencies [[`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/geometry@3.2.0

## 1.36.0

### Minor Changes

- [#1707](https://github.com/LTplus-AG/ifc-lite/pull/1707) [`87516cf`](https://github.com/LTplus-AG/ifc-lite/commit/87516cf5f502b1f770786199b2256c3a215331c3) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in cold (evict-to-disk) residency tier (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 3b).

  Three tiers: hot (GPU+CPU) / warm (CPU only, GPU evicted) / cold (metadata shell only, geometry restorable from a `ColdGeometryProvider` — the viewer wires the v13 cache entry with `Blob.slice` partial reads). `Scene.setHostResidencyBudget(bytes)` demotes warm buckets to cold LRU-first; eligibility is strict (pristine only — recoloured/moved/removed buckets are dirty; overflow "#N" sub-buckets excluded; provider present). Cold buckets are sealed (new arrivals route to a fresh sub-bucket), carried through finalize re-grouping as shells, and restored asynchronously on demand. `Scene.getResidentCpuBytes()` reports bucket CPU bytes. Off by default.

- [#1703](https://github.com/LTplus-AG/ifc-lite/pull/1703) [`5f1f8c1`](https://github.com/LTplus-AG/ifc-lite/commit/5f1f8c1a4261e0b8be39f835e88626118a58fef0) Thanks [@louistrue](https://github.com/louistrue)! - Contribution culling + frame/GPU-memory stats (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682) observability).

  - New opt-in `RenderOptions.contributionCull`: skip colour batches whose world AABB projects below a pixel threshold (raised while the camera moves). Conservative bounding-sphere math; never culls when the camera is inside a batch's bounds. Off by default.
  - New `Renderer.getFrameStats()`: draw calls issued plus batches drawn / frustum-culled / contribution-culled for the last completed frame.
  - New `Scene.getResidentGpuBytes()`: byte-accurate sum of GPU buffers held by colour batches, partial sub-batches, hydrated meshes, textured meshes and instanced templates.

- [#1705](https://github.com/LTplus-AG/ifc-lite/pull/1705) [`972341e`](https://github.com/LTplus-AG/ifc-lite/commit/972341e59d89dcf8d66aaebb7ffedc11523b701f) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in GPU residency budget (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 3a of the chunked-residency plan).

  `Scene.setGpuResidencyBudget(bytes)` evicts least-recently-drawn bucket batches (GPU buffers destroyed, CPU meshData + metadata shell kept) once their combined bytes exceed the budget, and rebuilds them on demand when the draw loop wants them again (`requestBatchResidency` + time-budgeted `processResidencyRestores`). Never evicts batches drawn this frame or idle fewer than 30 rendered frames; no-ops during streaming, in ephemeral mode, or after geometry release. `FrameStats` gains `batchesNotResident`. Off by default; pairs with spatial chunk bucketing.

- [#1708](https://github.com/LTplus-AG/ifc-lite/pull/1708) [`7a64fa7`](https://github.com/LTplus-AG/ifc-lite/commit/7a64fa75ba7cfcf22687a51a11a3eefe7bba7083) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in LOD1 as a second index range (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 5).

  `Scene.setLodBuildsEnabled(true)` builds a vertex-clustering-simplified index buffer over each bucket batch's EXISTING vertex data at batch-build time (>= 500 source triangles, ~2% AABB-diagonal cell, skipped when it does not pay); `RenderOptions.lod.screenPx` draws it for batches projecting below the threshold. LOD costs index bytes only — no second vertex buffer, per-vertex entityId picking lane preserved, LOD0 geometry untouched (no-weld invariant intact). Off by default.

- [#1711](https://github.com/LTplus-AG/ifc-lite/pull/1711) [`22db0d5`](https://github.com/LTplus-AG/ifc-lite/commit/22db0d53d7c42630673ca6bbca7bfcc208838118) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in 12-byte lattice-quantized batch vertices (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 6).

  `Renderer.enableQuantizedBatches()` (after a pipeline probe) switches batch builds to a 12-byte layout: uint16x4 position on a global 2^-10 m lattice + packed octahedral normal, plus the u32 entityId lane. The power-of-two lattice with lattice-aligned per-batch origins makes dequantization BIT-EXACT in f32, so cross-batch coincidence and depth-equal overlay matching survive quantization; batches exceeding the u16 range (64 m) fall back to f32 per batch. Measured: batch GPU bytes -37%, identical draw calls, 0.004% pixel delta. Off by default.

- [#1712](https://github.com/LTplus-AG/ifc-lite/pull/1712) [`afd6d1e`](https://github.com/LTplus-AG/ifc-lite/commit/afd6d1ee6fabcd060b4ed0ab5daa9cdd83ea5745) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in spatial chunk bucketing (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 2 of the chunked-residency plan).

  `Scene.setSpatialChunking({ cellSize })` partitions colour buckets by world grid cell, so batches become spatially compact and per-batch frustum/contribution culling fires at chunk granularity. Pure reorganization (pixel-identical rendering, same shared frame origin and draw path); a mesh never splits across cells; recolour, move/rotate re-bucketing, streaming fragments, finalize re-grouping and partial-batch piece filtering are all chunk-aware. Off by default.

## 1.35.2

### Patch Changes

- [#1692](https://github.com/LTplus-AG/ifc-lite/pull/1692) [`4ef69e9`](https://github.com/LTplus-AG/ifc-lite/commit/4ef69e903def842a9d94cd656a5caa176dd344bb) Thanks [@louistrue](https://github.com/louistrue)! - Link-based multiuser collaboration plumbing (ports draft [#937](https://github.com/LTplus-AG/ifc-lite/issues/937)):

  - `@ifc-lite/collab`: STEP → IFCX room seeding (`seedFromStep`), entity placement
    helpers (`usd::xformop` read/write + baselines), shared annotation pins,
    multi-mesh geometry refs (`geomIds` with legacy `geomId` read fallback,
    `addGeometryRef`, `iterGeometries`), presence `role` field, and a browser fix
    for `HttpBlobStore` (bind global `fetch` to avoid "Illegal invocation").
  - `@ifc-lite/collab-server`: signed room tokens (HS256 mint / verify / revoke /
    kick endpoints + `createRoomTokenAuthenticator`), CORS for the HTTP routes,
    disk-backed `FsBlobStorage`, `Room.kickClient` / `RoomManager.peek`, and a CLI
    that wires token auth + disk blobs from `COLLAB_TOKEN_SECRET` /
    `COLLAB_DATA_DIR` (plus a reference Dockerfile + railway.toml).
  - `@ifc-lite/renderer`: `rotateMeshesForEntity/-Entities` — in-place yaw rotation
    of an entity's flat meshes about a pivot (local-frame-origin aware), used by
    live collab placement sync and the viewer's rotate action.

- Updated dependencies [[`7432dd4`](https://github.com/LTplus-AG/ifc-lite/commit/7432dd47b235c9258950ae6ab1f02191b32f774e)]:
  - @ifc-lite/geometry@3.1.5

## 1.35.1

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/spatial@1.14.12

## 1.35.0

### Minor Changes

- [#1578](https://github.com/LTplus-AG/ifc-lite/pull/1578) [`5a9f384`](https://github.com/LTplus-AG/ifc-lite/commit/5a9f3846047c1920ff32e6833448b41b571d0e5c) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `Camera.zoomToFit(min, max, duration)` method. It had no callers anywhere in the repo (viewer, SDK, examples, tests) and was superseded by `Camera.frameBounds` (animated fit, keeps view direction) and `Camera.fitBoundsAdaptive` (aspect-aware fit used by the Home view and post-load auto-fit). The exported `Camera` class and the CI-tracked API surface are unchanged; only the dead convenience wrapper is gone. Callers that need an animated fit-to-bounds should use `frameBounds` (the quickstart cheat-sheet was updated to point at it).

### Patch Changes

- Updated dependencies [[`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/geometry@3.1.0

## 1.34.1

### Patch Changes

- [#1542](https://github.com/LTplus-AG/ifc-lite/pull/1542) [`810f917`](https://github.com/LTplus-AG/ifc-lite/commit/810f9177997953dc821568a3d68ecec0c57b0c56) Thanks [@louistrue](https://github.com/louistrue)! - Add an optional `ownerId` to `DrawingLine2D` so the IfcAnnotation / IfcGridAxis symbolic overlay can carry the express id of the entity that authored each segment. The section-cut and drawing-2d cutters leave it undefined; it lets the viewer drop an annotation's curves when the owning entity is hidden, without a mesh. Supports the terrain/annotation visibility fixes in [#1480](https://github.com/LTplus-AG/ifc-lite/issues/1480).

- Updated dependencies [[`e8997ea`](https://github.com/LTplus-AG/ifc-lite/commit/e8997ea79a473c443e524151fea4ad9470a4f42d)]:
  - @ifc-lite/geometry@3.0.2

## 1.34.0

### Minor Changes

- [#1486](https://github.com/LTplus-AG/ifc-lite/pull/1486) [`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(renderer): expose per-element local (object-space) bounding box + placement transform

  Recovering an element's TRUE oriented dimensions (length/width/height for a
  rotated/tilted member) previously required an expensive client-side vertex
  scan + PCA, since `Scene.getEntityBoundingBox` only returns a world-space
  (axis-aligned-to-world) AABB. The geometry pipeline already resolves each
  element's placement and briefly holds its pre-placement, object-space extent —
  this surfaces both instead of discarding them (issue [#1474](https://github.com/LTplus-AG/ifc-lite/issues/1474)):

  - `Scene.getEntityLocalBounds(expressId)` — the element's local (pre-placement)
    AABB, O(1) lookup. Unions across a multi-piece entity's mesh pieces (material
    layers, CSG parts) — all pieces of one element share a local frame, so no
    reconciliation is needed. For a GPU-instanced entity, returns the shared
    template's local box.
  - `Scene.getEntityTransform(expressId)` — the resolved `IfcLocalPlacement`
    chain, row-major 4×4, Y-up metres. For an instanced entity, returns the
    specific occurrence's transform.
  - `MeshData` gains `localBounds`/`localToWorld` (optional, session-only — not
    persisted to the disk/IndexedDB geometry cache, recomputed fresh each load
    like GPU-instancing metadata).

  Both return `null` for a container/assembly with no mesh (e.g.
  `IfcElementAssembly`) or when not captured (older cached geometry). Consumers
  can pair the two to reconstruct an oriented bounding box, or use it as a
  fallback when `Qto_*` `Length`/`Width`/`Height` quantities are absent.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/spatial@1.14.10

## 1.33.2

### Patch Changes

- a7f257e: Show the focused clash's REAL contact interface instead of an AABB box (#1402). New `@ifc-lite/clash/contact`: `contactClusters(meshA, meshB)` returns the contact patches — the shared-face polygon for coplanar/flush overlaps (surface), the intersection line for crossings (line), or a point — classified by area/length, via a Moller triangle-triangle test plus shared-face clustering (coplanar pairs Sutherland-Hodgman clipped on their common plane and unioned into a boundary polygon; cross pairs unioned along the intersection line). Computed on demand for the single focused pair. The renderer gains `setClashContactLines()` to draw the contact polygon outlines / intersection lines; the viewer prefers this over the box.
- Updated dependencies [1b148c1]
  - @ifc-lite/geometry@2.13.1

## 1.33.1

### Patch Changes

- 7de2936: Fix measure-snap missing all-but-one piece of a multi-piece flat mesh. The snap geometry cache
  keyed flat meshes on `expressId` alone (instanced occurrences already keyed on `occurrenceKey`,
  `#1405`), assuming one flat mesh per `expressId`. But mesh fragmentation routinely emits one
  entity as several flat `MeshData` pieces — e.g. an `IfcMechanicalFastener` "Bolt assembly" of
  mapped items materialized as 24 pieces sharing one `expressId` — and mapped copies share both
  `expressId` and local positions, differing only in `origin`. So the first piece's deduped
  vertices/edges were served for every other piece, and vertex/edge snap lit up on only one piece
  (one bolt of the group) while the rest fell back to a free-point face hit. The cache now keys
  flat pieces on a cheap content signature (`expressId` + `origin` + buffer sizes + sampled
  vertices), so every piece snaps; genuinely identical world geometry still shares one entry.

  Also fix the measure-snap radius being ~57× too small. `screenToWorldRadius` applied a
  degrees→radians conversion to `fov`, but its only caller passes `Camera.getFOV()`, which is
  already in radians. The shrunken radius made vertex/edge snap require sub-millimetre cursor
  precision and fall back to a face hit on small features (e.g. bolts). The conversion is
  removed; `fov` is treated as radians.

  Also fix the CPU pick/snap mesh collection dropping mapped copies. `collectVisibleMeshData`
  deduped flat pieces on a size-based key (`expressId` + `modelIndex` + buffer sizes), so the
  several flat pieces a mapped entity expands to — identical template geometry at different
  placements (e.g. the 4 bolts of one `IfcMechanicalFastener`) — collided and all but the first
  were dropped from the raycast set. The hidden bolts then returned no ray hit at all, so neither
  pick nor snap could reach them. The key now also includes the per-piece `origin` + first vertex,
  so distinct placements survive while a truly identical piece reached from both the regular and
  batched passes still dedups. (Mirrors the instanced-piece key fix from #1238 for the flat path.)

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0

## 1.33.0

### Minor Changes

- [#1410](https://github.com/LTplus-AG/ifc-lite/pull/1410) [`32fe7de`](https://github.com/LTplus-AG/ifc-lite/commit/32fe7de75745e0d7088f7979d6a83f238607cf21) Thanks [@louistrue](https://github.com/louistrue)! - Add `Camera.setOrbitAnchorBounds(bounds | null)` / `getOrbitAnchorBounds()` — an outlier-robust orbit-pivot anchor distinct from the full-scene `sceneBounds`. The renderer keeps `sceneBounds` pinned to the full model AABB (needed for near/far clipping and section ranges), but a handful of far-flung meshes can push that AABB's centre into empty space; when the anchor is set, the orbit-pivot fallback rotates around the tighter centre instead. Part of the fix for the model disappearing during orbit on sparse/outlier models ([#1394](https://github.com/LTplus-AG/ifc-lite/issues/1394)).

### Patch Changes

- [#1409](https://github.com/LTplus-AG/ifc-lite/pull/1409) [`76b6a4f`](https://github.com/LTplus-AG/ifc-lite/commit/76b6a4fd1c6f3710127e402c11636917a338ce38) Thanks [@louistrue](https://github.com/louistrue)! - Fix measure-snap missing all-but-one occurrence of GPU-instanced geometry ([#1405](https://github.com/LTplus-AG/ifc-lite/issues/1405)). `Scene.getInstancedMeshDataPieces` materializes one `MeshData` per instanced occurrence, all stamped with the same `expressId` but holding distinct world-space positions. `SnapDetector` cached the deduped vertices/edges/valence keyed on `expressId` alone, so the first occurrence's geometry was served for every later one (whose true world positions are elsewhere) and snap fell back to a free-point face hit — vertex/edge snapping lit up on only a single instance while raycast (which is cache-free) kept working on all of them. Materialized occurrences now carry a stable per-occurrence `occurrenceKey` (new optional field on `MeshData`), and the snap geometry cache keys on `occurrenceKey ?? expressId`, so snap works on every occurrence and the cache no longer collides instanced pieces with a flat mesh of the same `expressId`.

- Updated dependencies [[`76b6a4f`](https://github.com/LTplus-AG/ifc-lite/commit/76b6a4fd1c6f3710127e402c11636917a338ce38)]:
  - @ifc-lite/geometry@2.12.0

## 1.32.0

### Minor Changes

- [#1377](https://github.com/LTplus-AG/ifc-lite/pull/1377) [`2c331ad`](https://github.com/LTplus-AG/ifc-lite/commit/2c331addfc97fc67d2c022f65babb3f08d48c088) Thanks [@louistrue](https://github.com/louistrue)! - Add `Renderer.setClashOverlapBox(box | null)` — draws a world-space AABB as a distinct-colour wireframe box (e.g. the clash overlap region) via the existing overlay line pipeline. Pass `null` to clear. ([#1277](https://github.com/LTplus-AG/ifc-lite/issues/1277)/[#1339](https://github.com/LTplus-AG/ifc-lite/issues/1339))

## 1.31.0

### Minor Changes

- [#1360](https://github.com/LTplus-AG/ifc-lite/pull/1360) [`608e527`](https://github.com/LTplus-AG/ifc-lite/commit/608e5276637430e4a97f1aab0f50267a247fdbe2) Thanks [@Blogbotana](https://github.com/Blogbotana)! - renderer: add `Renderer.setOverlayLineColor(rgba)` so the 3D overlay lines (annotation / alignment / grid) and the section-cut outline are themeable. The line shader previously hardcoded black, leaving these lines invisible on dark backgrounds; the colour now comes from a uniform and defaults to opaque black (no behaviour change unless set). Complements `SymbolicTextInput.color`, which already themes the matching labels.

### Patch Changes

- [#1368](https://github.com/LTplus-AG/ifc-lite/pull/1368) [`1c27802`](https://github.com/LTplus-AG/ifc-lite/commit/1c27802ae79b402e540ff607b73bed29e02d897d) Thanks [@louistrue](https://github.com/louistrue)! - Fix picking of colour-merged fillers (IfcDoor / IfcWindow) under isolation. When a door or window is colour-fused into a batch keyed by its host wall or opening, its expressId lives only in the per-vertex `entityIds`, not in `batch.expressIds`. Picking now seeds its candidate set from the scene's authoritative mesh-data id set (`getAllMeshDataExpressIds()`), so an isolated door/window is hydrated and selectable instead of returning `null` from `pick()`. ([#1358](https://github.com/LTplus-AG/ifc-lite/issues/1358))

## 1.30.1

### Patch Changes

- [#1351](https://github.com/LTplus-AG/ifc-lite/pull/1351) [`18187fa`](https://github.com/LTplus-AG/ifc-lite/commit/18187facd6fa6fec15a23ef5e3263353730c5d8b) Thanks [@louistrue](https://github.com/louistrue)! - Keep small high-aspect elements on the compact camera-fit pose. The linear-infrastructure fit policy (camera positioned inside the bbox looking down the longest axis) is meant for railway / road alignments hundreds of metres long, but it triggered on any high-aspect bounding box regardless of absolute size. A single reinforcing bar viewed alone (e.g. a 4.86 m bar, aspect ~130:1) got framed end-on from inside its own bounding box and rendered as nothing (issue [#1350](https://github.com/LTplus-AG/ifc-lite/issues/1350)). The linear policy now requires the longest axis to be at least 100 m; below that the compact SE-isometric pose frames the whole element. Fixes the rendering half of [#1350](https://github.com/LTplus-AG/ifc-lite/issues/1350).

- Updated dependencies [[`0b73ebb`](https://github.com/LTplus-AG/ifc-lite/commit/0b73ebb785d378651e063ace128ad097991ccfb6)]:
  - @ifc-lite/geometry@2.10.1

## 1.30.0

### Minor Changes

- [#1331](https://github.com/LTplus-AG/ifc-lite/pull/1331) [`5193fdb`](https://github.com/LTplus-AG/ifc-lite/commit/5193fdb5f39a58cff2c4779dffcee5160df87227) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Add `RenderOptions.clipBox` — an axis-aligned, world-space clip box (section / crop box). The fragment shader discards geometry outside the six box planes, so consumers can crop to a real geometry cut instead of bounding-box element isolation. Independent of `sectionPlane`; both can be active. ([#1329](https://github.com/LTplus-AG/ifc-lite/issues/1329))

- [#1335](https://github.com/LTplus-AG/ifc-lite/pull/1335) [`54c86f9`](https://github.com/LTplus-AG/ifc-lite/commit/54c86f96dbb8acbd1c200a53378cbd9b0fa36d4a) Thanks [@louistrue](https://github.com/louistrue)! - Picking now mirrors the active section plane and clip box from the last render, so geometry clipped away by `RenderOptions.sectionPlane` or `RenderOptions.clipBox` is unpickable (single-click `pick` and rectangle `pickRect`), not just invisible. Both pick paths are covered: the GPU picker shaders and the CPU raycast fallback used for batched / large / released-geometry models (the latter falls through a sectioned/cropped surface to the nearest visible one behind it). No consumer wiring is needed: the renderer stashes what it actually clipped each frame and feeds it to the picker, so selection always matches what is visible. Point clouds are clipped by the section plane (matching the point render); the crop box clips triangle meshes only. ([#1329](https://github.com/LTplus-AG/ifc-lite/issues/1329))

## 1.29.2

### Patch Changes

- [#1311](https://github.com/LTplus-AG/ifc-lite/pull/1311) [`207a4fb`](https://github.com/LTplus-AG/ifc-lite/commit/207a4fba4b86b2db67e8784b4d7b05a52cd86960) Thanks [@louistrue](https://github.com/louistrue)! - Reconstruct per-layer section fills from open (cap-free) material-layer bands. The geometry slicer no longer caps the layer interface planes — capping doubled each shared interface into a coincident, non-watertight "ghost face" sheet and ~tripled the triangle count on layered walls. With the interfaces left open, the 2D section's polygon builder is now bidirectional (each open band closes at the interface chord) and, for 3+ layer walls, stitches the disconnected end strips of an interior layer (which has no wall face) back into a closed fill at the interface chords — so every layer keeps its section fill.

  Harden that reconstruction on OPENING-cut walls so the 3D section cap covers every layer (no more wall-reads-hollow in section view). An opening splits each layer into disconnected solid chunks; the old greedy nearest-endpoint stitch hopped an interior layer's strip to the strip ACROSS the opening, emitting one self-overlapping polygon that bridged the void and failed to fill. Closure now runs along the interface lines (the principal/length axis of the band, so it is robust to rotated walls): endpoints are paired CONSECUTIVELY along each interface line, which closes each solid chunk and leaves the opening between chunks empty. Ambiguous layouts fall back to the previous stitch, so no case is made worse.

  Add an opaque base-cap backstop so a 3D section cut can NEVER read see-through, even on a wall the per-layer reconstruction cannot resolve. For each multi-material entity the builder also emits its full closed cross-section (the watertight union of the bands always closes, so this needs no interface stitching), carried in a new `Drawing2D.layerBaseCutPolygons` that ONLY the 3D section overlay consumes (the flat 2D drawing, SVG export, and measure/snap paths are untouched). The overlay draws this opaque base first and the per-layer colours over it, so the colours show where they reconstruct and solid cut material shows everywhere else.

  Fix multilayer walls reading HOLLOW in normal (uncut) 3D, not just in section. The renderer backface-culled material-layer slices on the assumption their winding was reliably outward — correct for the OLD closed per-layer slabs (the cull hid their coincident interface caps). Since the slabs became open bands whose union is the wall's watertight outer skin (no caps), and IFC winding is not reliably outward, culling dropped inward-wound faces and punched holes, so the wall looked like a thin see-through shell. Layer slices now render DOUBLE-SIDED like all other IFC geometry: every face of the watertight skin draws, so the wall reads solid. With no coincident caps left there is nothing to z-fight, so the cull that motivated the special pipeline is removed (the `GEOM_CLASS_LAYER_SLICE` tag stays — it now only marks per-layer section fills).

## 1.29.1

### Patch Changes

- [#1315](https://github.com/LTplus-AG/ifc-lite/pull/1315) [`582fc07`](https://github.com/LTplus-AG/ifc-lite/commit/582fc077272c6a9cc0db87711e2828f41d0983bd) Thanks [@louistrue](https://github.com/louistrue)! - Stop a lost-device `popErrorScope` rejection from surfacing as an unhandled `DOMException`.

  During the first few frames the renderer wraps the render pass in `pushErrorScope('validation')` and reads it back with `device.popErrorScope()`. That promise rejects (`OperationError: Instance dropped in popErrorScope`) when the GPU device is lost while the scope is still pending — something seen in the wild on Windows/Edge when the adapter resets. The `.then()` had no rejection handler, so the rejection escaped the surrounding synchronous `try/catch` and became an unhandled rejection reported as a top-level error. It is now caught and treated like any other device loss: the context is invalidated so it reconfigures on the next frame, with a throttled warning instead of a crash.

## 1.29.0

### Minor Changes

- [#1290](https://github.com/LTplus-AG/ifc-lite/pull/1290) [`07dedbc`](https://github.com/LTplus-AG/ifc-lite/commit/07dedbcaa4f970b26134ae68aef5105761754011) Thanks [@louistrue](https://github.com/louistrue)! - Add `ghostExceptIds` / `ghostAlpha` to `RenderOptions` — an X-Ray _context_ mode
  that fades every non-selected mesh NOT in the set to a translucent alpha, while
  the focused subset stays solid. It feeds the existing `transparencyOverrides`
  alpha path (explicit per-id entries still win, selected meshes stay opaque), so
  callers can ghost "the rest" of a model without building a Map over every
  element. Same id space as `isolatedIds`.

### Patch Changes

- [#1291](https://github.com/LTplus-AG/ifc-lite/pull/1291) [`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf) Thanks [@louistrue](https://github.com/louistrue)! - Fix Exploded level-display mode leaving geometry behind ([#1289](https://github.com/LTplus-AG/ifc-lite/issues/1289)).

  Two independent defects made Exploded mode look broken:

  - GPU-instanced occurrences (repeated geometry emitted via `IfcMappedItem`, e.g.
    windows / mullions) were never lifted with their storey, because the per-entity
    translate only touched the flat `meshDataMap` and not the instanced shard. They
    stayed at their native elevation while the rest of the storey rose ("objects
    left behind"). `Scene.translateInstancedEntity` now shifts each occurrence's
    transform in both the CPU instance record and the GPU buffer, plus its cached
    world AABB, so pick / measure / section / export stay correct. This also fixes
    moving an instanced element with the gizmo.

  - A storey whose `Elevation` attribute is null (common in Revit / ArchiCAD
    exports) was dropped from the elevation map, so Exploded mode had a single
    floor to order ("only one floor"). The spatial-hierarchy builder now falls back
    to the storey's `ObjectPlacement` Z when the attribute is missing.

- Updated dependencies [[`84c9f6e`](https://github.com/LTplus-AG/ifc-lite/commit/84c9f6e09eba2747b37da8f74aa7de23cb9f96d3)]:
  - @ifc-lite/geometry@2.9.2

## 1.28.5

### Patch Changes

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Bring GPU-instanced occurrences to full feature parity with the flat path so they
  behave correctly across every consumer, not just the opaque render:

  - **Hide / isolate**: a per-instance hidden flag (shader discard in both the render
    and pick passes) driven by `Scene.setInstancedVisibility(hiddenIds, isolatedIds)`,
    so hidden/isolated instanced elements neither draw nor are pickable.
  - **Transparency**: a transparent instanced pipeline (alpha blend, no depth write) +
    a second instanced sub-pass for occurrences a lens-ghost / x-ray / compare override
    made translucent — previously they rendered solid. Zero-cost when nothing is ghosted.
  - **CPU consumers**: a compact CPU view of the instanced templates (geometry +
    per-occurrence matrices) yields per-occurrence world AABBs (folded into
    `boundingBoxes`, so `getEntityBoundingBox` / bbox-raycast / BCF resolve instanced
    ids) and lazy on-demand `getInstancedMeshDataPieces` for exact raycast — wired into
    the raycast-engine (measure-snap, section-by-face) with a ray-AABB pre-cull. New
    `getInstancedEntityBounds`, `getInstancedEntityIds`, `getAllInstancedMeshData`,
    `isInstancedEntity` accessors. The memory win holds: geometry is materialized on
    demand, never retained as N full copies.

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Add the WebGPU GPU-instancing draw path: a `vs_instanced` shader entry + parallel
  instanced pipeline (template vertex buffer at slot 0, per-occurrence buffer at
  slot 1 carrying mat4 + entityId + rgba) drawn as `drawIndexed(indexCount,
instanceCount)`, plus `Scene.addInstancedShard` to upload a decoded IFNS shard.
  The fragment shader now reads a `color` interstage varying (equivalent to the
  prior `uniforms.baseColor` for the flat path; per-occurrence for the instanced
  path). The pass is additive and **inert until a shard is fed** (no templates ⇒ no
  draws ⇒ the flat path is byte-identical), so nothing renders through it yet — the
  worker→main shard plumbing is a follow-up.

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Add GPU-instancing render prep (`prepareInstancedRender`, `composeInstanceMatrix`)
  that turns a decoded IFNS shard into render-ready templates: each unique geometry
  once plus a per-instance buffer (mat4 + entityId + rgba) for `drawIndexed(.., instanceCount)`.
  The per-instance matrix folds the constant IFC Z-up→WebGL Y-up swap into
  `SWAP·rel_k·T(origin)`, so instanced occurrences land in the exact same world
  frame the flat path produces (`swap(rel_k·(origin+p)) == swap(origin_k+p_k)`),
  verified GPU-free against an independent re-derivation. Additive and unused by the
  default draw path until the instanced pipeline is wired.

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - GPU-instancing review follow-ups: reject truncated instanced-shard cache payloads
  and instances referencing missing templates; carry geometry-diff hashes for
  instanced-only entities so model compare still detects their changes; fix the
  raycast BVH to rebuild on a same-count-different-members instanced set and the
  instanced-piece dedup key collision; tombstone instanced-only entities on
  delete/split; wire instanced occurrences into the CPU enumeration / raycast
  paths; reset instancing metadata in Mesh::clear; guard verify_recomposition
  against vertex-count mismatches; validate the transparent-instanced pipeline via
  a GPU error scope.
- Updated dependencies [[`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b), [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b), [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b), [`b125ae6`](https://github.com/LTplus-AG/ifc-lite/commit/b125ae60f0a7227ea42dfb0f95230e29c7f645ff), [`7f5e543`](https://github.com/LTplus-AG/ifc-lite/commit/7f5e543fee7b8f92109bf1b581120f3571f1e445)]:
  - @ifc-lite/geometry@2.9.1

## 1.28.4

### Patch Changes

- [#1220](https://github.com/LTplus-AG/ifc-lite/pull/1220) [`a76b782`](https://github.com/LTplus-AG/ifc-lite/commit/a76b78284ea3bd1c4eceee805bdf2f16f4043266) Thanks [@louistrue](https://github.com/louistrue)! - Fix lens/IDS/compare/4D colour overlays silently failing to paint. The
  anti-z-fight depth nudge in the vertex shader folded the per-draw `baseColor`
  into its hash, so the colour-override overlay (drawn over the base geometry
  with `depthCompare: 'equal'`) computed a different nudged depth than the base
  pass — material colour vs. override colour — and every overlay fragment was
  rejected. Symptom: the lens panel reported "N coloured" but the 3D model stayed
  its default colour.

  The depth nudge now reads an 8-bit material-colour salt baked into the high 8
  bits of the per-vertex entity-id lane (low 24 bits remain the picking id, which
  `encodeId24` masks the salt off of), instead of the draw-time `baseColor`. The
  base and overlay passes therefore compute an identical nudge — so the overlay's
  `equal` depth test matches and colour paints — while distinct material layers
  still receive distinct depths, preserving the coplanar-layer separation. Picking
  is unaffected.

- Updated dependencies [[`744f9f8`](https://github.com/LTplus-AG/ifc-lite/commit/744f9f8796a6e8cdcdfb586c47e9019ea7813208)]:
  - @ifc-lite/geometry@2.7.10

## 1.28.3

### Patch Changes

- [#1160](https://github.com/LTplus-AG/ifc-lite/pull/1160) [`631511e`](https://github.com/LTplus-AG/ifc-lite/commit/631511eedb135ea8bfc7caf640edea8862b86a59) Thanks [@louistrue](https://github.com/louistrue)! - Restore per-layer slicing of single-solid walls/slabs with an `IfcMaterialLayerSetUsage`. Slicing turns one solid into one coloured sub-mesh per material layer (geometry_id = the layer's `IfcMaterial`) so the build-up is visible in 3D. The "Merge Multilayer Walls" toggle now does what its label promises for these walls too — "render walls as one solid": with the toggle on, the layer index is not attached, so each wall stays a single swept solid instead of slicing into layers (off, the default, shows the layered build-up).

  The slicing kernel stayed intact, but [#874](https://github.com/LTplus-AG/ifc-lite/issues/874) (mesh-production unification) dropped the `set_material_layer_index` wiring from every pipeline, so the router's index was always `None` and `try_layered_sub_meshes` never fired — layered walls silently rendered as a plain single solid in the browser, native, and server paths. Re-wire it: build the `MaterialLayerIndex` once per load (cached on the IfcAPI for the streaming path, with a cheap substring bail-out so files with no layer set pay nothing) and attach it to every batch router. This also restores the "Merge Multilayer Walls" toggle for models whose sliceable walls carry their geometry as `IfcBuildingElementPart`s — the merged parent now actually draws its sliced solid instead of leaving a gap.

  2D section now shows the layers too. The section cutter carries each sub-mesh's colour onto its cut segments (CPU and GPU paths), and the polygon builder splits one entity's cut into a polygon per material colour — single-material elements still produce one colourless polygon, so their existing per-`ifcType` / per-entity fill is unchanged. When the viewer shows IFC materials, each sliced layer fills with its own `IfcMaterial` colour instead of one colour for the whole wall, and the layer divisions are drawn as outlines — matching the 3D build-up.

  Two follow-on robustness fixes:

  - **3D layer glitch (z-fighting).** Adjacent layer slabs share the parent wall's `expressId`, so the renderer's per-entity depth nudge (keyed on `entityId`) gave their coincident interior interface caps the SAME depth — under `cullMode: 'none'` + MSAA that z-fought into a flickering comb that read as "see inside / not solid". The shader now folds the per-draw `baseColor` into the depth-nudge hash; batches are keyed by colour, so abutting layers (distinct colours) land on distinct depths. Constant per draw, so flat faces stay flat and curved surfaces are unaffected.

  - **Cap watertightness on irregular profiles.** A layer slab's innermost cut is built by two successive plane clips; on a non-convex `IfcArbitraryClosedProfileDef` the two passes deposit geometrically-coincident section vertices that differ by ~1 ULP. `cap_half_space_clip` welded by exact f32 bits, so those twins stayed separate, the boundary chain dead-ended and a cap sub-loop was silently dropped — leaving open edges (a hole you could see through and a section with no fill there). The cap now welds on a spatial grid tied to its on-plane tolerance, collapsing the twins so the loop closes. Single-plane callers (opening cuts) have no such twins and are unaffected.

  - **3D section cut read hollow.** The live 3D section cap (`Section2DOverlayRenderer`) filled each cut polygon with a naive convex fan over the outer ring only, ignoring holes — a long-standing KNOWN LIMITATION. On the concave cross-sections that arbitrary IFC profiles (and material-layer slabs) cut into, the fan inverts and leaves the cut face uncovered, so a sectioned wall read as a hollow shell. The fill now uses the renderer's existing hole-aware ear-clipping (the same one the annotation-fill path uses), so the cut face is solid. The cap also now honours a per-polygon colour: a material-layer wall fills each layer of its 3D section cut with that layer's `IfcMaterial` colour (matching the 3D solids and the 2D section), while single-material cuts keep the uniform cap style + hatch unchanged via a sentinel.

  - **Solid layered 3D walls via backface culling.** Rendering a material-layer wall as N thin coincident-faced layer solids made it shimmer / read as a hollow shell — adjacent layers' interface caps z-fight under the viewer's double-sided rendering (culling is globally off because general IFC winding is unreliable), and same-material adjacent layers can't be depth-separated. The layer slices DO have reliable outward winding, though, so they're now tagged `geometryClass` 3 and the renderer draws that class with a dedicated **backface-culling** pipeline: the build-up stays visible on the wall's faces and edges, but the interior coincident caps never rasterise, so the wall reads as a clean solid (and a section cut through it shows the interior material surface rather than a hollow shell). The 2D/section cut consumes the same class — it never culls — for its per-layer fills. Cache `FORMAT_VERSION` → 9 so stale caches re-mesh with the class-3 slices.

- Updated dependencies [[`631511e`](https://github.com/LTplus-AG/ifc-lite/commit/631511eedb135ea8bfc7caf640edea8862b86a59)]:
  - @ifc-lite/geometry@2.7.6

## 1.28.2

### Patch Changes

- [#1148](https://github.com/LTplus-AG/ifc-lite/pull/1148) [`81a6cdf`](https://github.com/LTplus-AG/ifc-lite/commit/81a6cdf93aa0af2e306f3697c2912f56405e8856) Thanks [@louistrue](https://github.com/louistrue)! - Add `Camera.getSceneBounds()` — an O(1) accessor for the cached scene bounds (the value last passed to `setSceneBounds`). The viewer uses it to anchor the orbit pivot to the scene centre on a raycast miss / large model, instead of the drifting camera target which made repeated rotation feel untethered (issue [#1107](https://github.com/LTplus-AG/ifc-lite/issues/1107)).

- [#1161](https://github.com/LTplus-AG/ifc-lite/pull/1161) [`ef8343b`](https://github.com/LTplus-AG/ifc-lite/commit/ef8343baeb50f6de00c3ca3c31ab15849ebb2528) Thanks [@louistrue](https://github.com/louistrue)! - Keep internal edges/facets visible on selected objects.

  The selection highlight painted every fragment a single flat blue (`color = vec3(0.3, 0.6, 1.0)`), discarding all lighting. Because the viewer's "internal lines" are really the per-face shading step of flat-shaded facets, that flat fill collapsed a selected object into one featureless silhouette — creases and bends disappeared the moment it was highlighted (the faint screen-space edge line alone could not stand in for the lost face-shading cue).

  The highlight now re-lights a selection-blue albedo with the scene's own lighting term instead of overwriting it. The base material colour never enters the result (no green-site / red-roof bleed-through, the reason the flat override existed), but the per-face brightness variation is preserved, so internal edges read on the highlight exactly as they do unselected. A multiplicative gain on the lighting luminance keeps sunlit faces at full selection-blue, with a floor/ceiling clamp so shadowed faces only dim and bright scenes never wash out.

- Updated dependencies [[`69e5425`](https://github.com/LTplus-AG/ifc-lite/commit/69e5425e3d7586fcc2d44a33465806adc0ed53f8), [`bd585c7`](https://github.com/LTplus-AG/ifc-lite/commit/bd585c73de1f39db3c9aac168174012b98b79855), [`200681b`](https://github.com/LTplus-AG/ifc-lite/commit/200681ba17f162aaafaabf56c0723ddba693faf8)]:
  - @ifc-lite/geometry@2.7.3

## 1.28.1

### Patch Changes

- [#1120](https://github.com/LTplus-AG/ifc-lite/pull/1120) [`d5fe21e`](https://github.com/LTplus-AG/ifc-lite/commit/d5fe21ef7e066466ceceedbac5d66b3104c4a7aa) Thanks [@louistrue](https://github.com/louistrue)! - Fix the ghost left when moving (or deleting/splitting) a selected element. The
  per-entity selection-highlight meshes in `Scene.meshes` are frozen position
  copies made at selection time and were only ever cleared by `clear()` — so an
  element moved while selected (the gizmo holds the selection through the drag)
  kept drawing its highlight at the OLD position, a faint duplicate. `Scene` now
  evicts an entity's standalone highlight meshes (freeing their GPU buffers) in
  `translateMeshesForEntity` and `removeMeshesForEntity`, so the highlight is
  re-extracted from the entity's current geometry on the next frame.

- [#1120](https://github.com/LTplus-AG/ifc-lite/pull/1120) [`d5fe21e`](https://github.com/LTplus-AG/ifc-lite/commit/d5fe21ef7e066466ceceedbac5d66b3104c4a7aa) Thanks [@louistrue](https://github.com/louistrue)! - Add `Scene.hasStreamingFragments()` and `Scene.isEphemeralStreaming()`
  accessors. They let the viewer detect an element that was appended during
  streaming and still rendered as a streaming fragment — which, after the element
  is moved (its colour bucket re-batched), would otherwise linger as a ghost
  duplicate at the original position — and finalise the fragments into clean
  buckets (skipping ephemeral mode, where no geometry is retained to rebuild from).

- [#1120](https://github.com/LTplus-AG/ifc-lite/pull/1120) [`d5fe21e`](https://github.com/LTplus-AG/ifc-lite/commit/d5fe21ef7e066466ceceedbac5d66b3104c4a7aa) Thanks [@louistrue](https://github.com/louistrue)! - Fix `Scene.translateMeshesForEntity` skipping single-entity meshes. The move
  gizmo couldn't move an authored element (a baked IfcSpace, or an added
  slab/wall/…) even though its placement and bounding box resolved: those meshes
  tag every vertex with their own entity id for picking, and the translate path
  skipped _any_ mesh with a non-empty `entityIds` (meant to protect shared
  colour-merged meshes from dragging unrelated entities). Now it skips only a
  genuine merge — one whose vertices carry a _different_ entity id — so a
  single-entity mesh (all vertices tagged with the target id) translates as
  expected. Parsed single-entity meshes (empty `entityIds`) are unaffected.

## 1.28.0

### Minor Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

### Patch Changes

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0
  - @ifc-lite/spatial@1.14.9

## 1.27.0

### Minor Changes

- [#1069](https://github.com/LTplus-AG/ifc-lite/pull/1069) [`49d146a`](https://github.com/LTplus-AG/ifc-lite/commit/49d146a653f65eb5e265347ed6a9e9e7a21589a4) Thanks [@louistrue](https://github.com/louistrue)! - Sky and lighting options for both rendering paths.

  Renderer: the hardcoded shader lights move into a global lighting-environment
  uniform (group(1)) — sun direction/colour/intensity, hemisphere ambient,
  exposure — with defaults that render pixel-identical to the previous look,
  plus a procedural sky pass (analytic gradient + sun disc, drawn at the
  reverse-Z far plane, tonemapped with the same ACES curve as geometry).

  Viewer: one collapsible, mode-aware Sun & Sky panel. Standalone it offers
  lighting presets (Default, Day, Overcast, Evening, Night), a Sky toggle and
  an exposure trim; in the Cesium world context the model is lit by the sun
  and atmosphere, so the panel swaps presets for the Sky/atmosphere toggle and
  the sun-path study. The study now also lights the model directly: the NOAA
  sun position at the site is mapped into viewer space (inverse of the Cesium
  bridge's ENU frame) with golden-hour/twilight/night photometric fades, so
  daylight studies read identically with and without the 3D world context.

  Cesium: OSM Buildings mode keeps the globe with the satellite base map —
  buildings sit on top of the imagery instead of replacing it, and the globe
  receives the buildings' and model's cast shadows during a sun study.

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe)]:
  - @ifc-lite/geometry@2.6.1

## 1.26.0

### Minor Changes

- [#1068](https://github.com/LTplus-AG/ifc-lite/pull/1068) [`2113143`](https://github.com/LTplus-AG/ifc-lite/commit/21131434f01807b79a80027863078172d681fb52) Thanks [@louistrue](https://github.com/louistrue)! - Keep contact shading and separation lines visible during camera interaction
  (orbit/zoom/pan and camera animations) instead of unconditionally disabling
  them and popping them back on a settle frame. Adds the optional
  `RenderOptions.interactionFrameIntervalMs` so apps that intentionally cap
  continuous render cadence (large-model throttles) are judged against their
  own schedule rather than display refresh.

  An adaptive governor (`InteractionEffectsGovernor`) measures the cadence of
  interactive frames: effects stay on while the renderer keeps up with the
  display refresh (the post pass costs well under a millisecond on
  discrete/Apple GPUs at CSS resolution — Autodesk's viewer likewise keeps
  effects on during desktop navigation). On GPUs that measurably miss frames
  (integrated GPUs at large canvases), effects degrade for the rest of the
  gesture — the previous behaviour — with up to three re-probes before
  settling on degraded mode for the session.

  Edge contrast is no longer interaction-gated at all: its gated tail is a
  handful of ALU ops (the expensive derivative work always ran), so disabling
  it bought nothing and only made crease darkening pop around gestures in
  orthographic mode.

  The viewer app now also requests a settle frame when a camera tween
  (Home / view cube / zoom-extent) completes, so the last animation frame can
  no longer remain on screen at degraded quality.

### Patch Changes

- [#1067](https://github.com/LTplus-AG/ifc-lite/pull/1067) [`13f54fe`](https://github.com/LTplus-AG/ifc-lite/commit/13f54fe54238051b10a343ede62231044f3741f4) Thanks [@louistrue](https://github.com/louistrue)! - Fix grazing-angle shading artifacts: diagonal lighter/darker bands on flat
  walls and slabs, and dashed/broken separation lines along wall corners.

  Root cause: the derivative-based flat-shading normal
  (`cross(dpdx(worldPos), dpdy(worldPos))`) is numerically sign-unstable at
  grazing view angles — the hemisphere-ambient and rim-light terms then
  band-flip across large regions of a single flat surface (and on the 1–2 px
  z-hash slivers along entity corners, which rendered as dark dashes). The
  normal's direction is now kept from the screen-space derivatives (preserving
  the coplanar-strip scar-line immunity) while its sign is stabilized by the
  interpolated vertex normal, guarded against missing/near-perpendicular
  vertex normals. The textured shader inherits the fix through its anchored
  derivation.

  The separation-lines pass additionally gained a per-axis second-difference
  "crease" gate (3e-4 relative) alongside the existing 5e-4 first-difference
  gate, so depth-continuous wall/wall and floor/wall seams draw consistently
  instead of flickering around the threshold (dashed lines). Coplanar
  continuations stay suppressed: their second difference is bounded by the
  anti-z-fight hash offset (≤2.55e-4). No new texture loads; both changes are
  a few ALU ops — verified flat 60 fps (0 frames >20 ms over 300 forced
  full-effect renders) and zero load-time impact.

## 1.25.4

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/spatial@1.14.8
  - @ifc-lite/wasm@2.5.1

## 1.25.3

### Patch Changes

- [#1029](https://github.com/LTplus-AG/ifc-lite/pull/1029) [`cef9989`](https://github.com/LTplus-AG/ifc-lite/commit/cef99897ee287029c6db6bbaafcd2a35508af1be) Thanks [@louistrue](https://github.com/louistrue)! - fix(renderer): double-sided GPU pick pass — back-face culling could cull an
  element's entire camera-facing surface (IFC winding order varies), so clicks
  selected whatever was behind it (e.g. an IfcSpace behind a wall).

  fix(create): space bakes now survive the IFC round-trip —
  `addSpaceToStore` emits geometry in the model's native length unit
  (a space baked into a millimetre model used to export 1000× too small),
  and `resolveSpatialAnchor` no longer fails on models without
  `IfcOwnerHistory` (OPTIONAL from IFC4 onward); builders emit `$` instead.

  fix(viewer): Space Sketch surfaces real bake errors instead of counting
  them as "already a space" skips, reveals the (persisted) Spaces class
  visibility after a successful bake, and the toolbar button is edit-mode
  gated with a distinct icon.

- Updated dependencies [[`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692)]:
  - @ifc-lite/wasm@2.5.0

## 1.25.2

### Patch Changes

- [#1015](https://github.com/LTplus-AG/ifc-lite/pull/1015) [`417ea3f`](https://github.com/LTplus-AG/ifc-lite/commit/417ea3fa5a6a0bcd71b06ba08b83d824af49bf3c) Thanks [@louistrue](https://github.com/louistrue)! - Fix selected-object colour bleeding through the selection highlight. The highlight was a fresnel _glow_ — `mix(litColor, highlightColor, fresnel * 0.5 + 0.2)` — so at a face viewed head-on the mix factor floored at 0.2, leaving ~80% of the lit object colour visible (e.g. the green IfcSite and red roof slab showed through the blue highlight, as a lighting-dependent gradient). The selection highlight is now a single flat colour, so a selected object reads as one uniform blue with no base-colour bleed and no gradient.

## 1.25.1

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

- Updated dependencies [[`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/wasm@2.3.0
  - @ifc-lite/spatial@1.14.7

## 1.25.0

### Minor Changes

- [#969](https://github.com/LTplus-AG/ifc-lite/pull/969) [`f3cb460`](https://github.com/LTplus-AG/ifc-lite/commit/f3cb4600bf67f60a200a90bc70c233effbabe76e) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(grids): render structural grids in apps/viewer ([#967](https://github.com/LTplus-AG/ifc-lite/issues/967))

  Wire the structural-grid SDK from [#966](https://github.com/LTplus-AG/ifc-lite/issues/966) into the in-repo viewer, mirroring the
  alignment-lines stack (lines-only for now).

  - **`@ifc-lite/renderer`**: `uploadGridLines3D` / `clearGridLines3D` (+ internal
    `hasGridLines3D` / `drawGridLines3D`) — a dedicated grid line buffer drawn
    through the existing line pipeline, independent of the annotation/alignment
    overlays. Unlike alignment, grid lines don't expand model bounds (they sit
    behind a visibility toggle and routinely extend past the envelope). Also frees
    the alignment + grid line buffers on overlay `dispose()`.
  - **`@ifc-lite/viewer`**: `useGridLines3D` hook (mirrors `useAlignmentLines3D`,
    calls `GeometryProcessor.parseGridLines`), wired in `Viewport` and gated by the
    existing `ifcGrid` type-visibility toggle.

  3D tag/bubble labels and full polyline sampling for curved axes are deferred (see
  [#967](https://github.com/LTplus-AG/ifc-lite/issues/967)).

- [#962](https://github.com/LTplus-AG/ifc-lite/pull/962) [`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC surface textures on tessellated geometry ([#961](https://github.com/LTplus-AG/ifc-lite/issues/961)).

  `IfcBlobTexture` (embedded PNG **and** JPEG) and `IfcPixelTexture` (raw pixel
  literals) are now decoded to RGBA8 entirely in Rust (the `png` and
  `jpeg-decoder` crates) and the per-triangle `IfcIndexedTriangleTextureMap` /
  `IfcTextureVertexList` coordinates are emitted as per-vertex UVs in lockstep with
  the flat-shaded tessellation (the authored texture coordinates are used directly,
  mapping the image ~1:1 like the buildingSMART reference; the whole-shell
  orientation flip is mirrored onto the texture indices so UVs stay aligned). The
  decoded RGBA + UVs ride on `MeshData` across the wasm boundary; the WebGPU
  renderer gains a dedicated textured pipeline that uploads the texture and draws
  textured meshes in their own sub-pass, preserving picking, section-clipping and
  flat-shading. The buildingSMART annex-E "tessellated shape with style" boilers
  now render textured instead of flat white.

  All image/texture decoding lives in Rust so the server, CLI and SDK get the same
  result — the browser only uploads the bytes to the GPU. `IfcImageTexture`
  (external URL) remains out of scope (needs an async fetch resolver).

### Patch Changes

- Updated dependencies [[`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`f99666a`](https://github.com/LTplus-AG/ifc-lite/commit/f99666ae028a88f1378422dd20900929f026cd2b), [`773b508`](https://github.com/LTplus-AG/ifc-lite/commit/773b5086456de3c61bdde8a72dd3d35325e2e995)]:
  - @ifc-lite/wasm@2.2.0
  - @ifc-lite/geometry@2.2.0

## 1.24.0

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
  - @ifc-lite/geometry@2.1.0

## 1.23.1

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/spatial@1.14.6

## 1.23.0

### Minor Changes

- [#872](https://github.com/LTplus-AG/ifc-lite/pull/872) [`680f979`](https://github.com/LTplus-AG/ifc-lite/commit/680f979385e6073ee99b4b31824490cb0c8d30f0) Thanks [@louistrue](https://github.com/louistrue)! - ROOT-CAUSE fix for visible triangulation / scar lines on flat surfaces
  after every CSG operation (opening subtraction, layer slicing). Switch
  the main fragment shader from interpolated vertex normals to
  derivative-based flat shading for the lit normal, matching the
  industry standard for BIM/CAD viewers (Three.js
  `material.flatShading`, Autodesk Forge, Speckle, xeokit).

  ### Why this is the right fix

  The visible "horizontal striations on walls", "stripes on slabs",
  "triangulation lines" the user reports across the legacy BSP kernel
  AND the Manifold kernel all come from one thing: per-vertex normal
  averaging on a mesh whose strip-boundary vertices carry slightly
  different f32 positions / normals coming out of the CSG. CPU-side
  welding + crease-aware smoothing (the previous attempts on PR [#861](https://github.com/LTplus-AG/ifc-lite/issues/861))
  helps but never fully eliminates it — any per-vertex normal can carry
  sub-ulp noise that the rasteriser amplifies into a visible line at
  strip boundaries.

  `cross(dpdx(worldPos), dpdy(worldPos))` evaluates to the EXACT face
  normal in the fragment shader. Every fragment on a flat face — across
  an arbitrarily-fine triangulation — gets the IDENTICAL normal, so
  coplanar splits become invisible by construction. The CSG kernel can
  emit as many strip triangles as it wants; the rendered surface looks
  like one continuous face.

  ### Trade-off

  Genuinely curved surfaces (cylinder tessellations, BSpline
  approximations) shade with visible facets at the triangle resolution
  the IFC author chose. For BIM that's acceptable — curved surfaces are
  < 5 % of typical model triangle count and the faceting matches
  Revit / ArchiCAD on-screen behaviour at default quality. Future work
  could add a per-primitive smooth-shading flag for explicit smooth
  surfaces; until then, flat-by-default is correct for the dominant case.

  ### Secondary fix

  The edge-enhancement pass also switched from interpolated-vertex-normal
  gradient to face-normal gradient. Without that change the edge
  enhancer would draw the same false dark stripes from vertex-normal
  noise — only the LIT normal would be clean. Now both light and edge
  agree: coplanar adjacent triangles produce zero gradient → no spurious
  edge; real wall-meets-floor creases produce a large gradient → the
  intended outline.

  ### Verification

  `pnpm --filter @ifc-lite/renderer build` typechecks clean. The fix is
  a shader-only change to `packages/renderer/src/shaders/main.wgsl.ts`;
  no Rust or test changes required. Visual verification on deploy
  preview required — load any model that previously showed scar lines
  (BIMcollab Example, ifc4 walls with openings, etc.).

### Patch Changes

- Updated dependencies [[`cc28f46`](https://github.com/LTplus-AG/ifc-lite/commit/cc28f4675b7cdca67ff6c97a6461337e17468fd2), [`df912ca`](https://github.com/LTplus-AG/ifc-lite/commit/df912cafb1f3632abadee5134324165e5c1a084f), [`eada6ad`](https://github.com/LTplus-AG/ifc-lite/commit/eada6ad841d0dd5179088a8ba0b2bc6783d33e8d), [`9e2a644`](https://github.com/LTplus-AG/ifc-lite/commit/9e2a6440ff658f0c5fd58fc23d193fb8ddd897a4), [`b2d6f2a`](https://github.com/LTplus-AG/ifc-lite/commit/b2d6f2a023935446ae8e9b7dc6e436dedd1555ad), [`4632362`](https://github.com/LTplus-AG/ifc-lite/commit/46323626deed90ac5d5221569831ea6fcd6e0889), [`14d69d3`](https://github.com/LTplus-AG/ifc-lite/commit/14d69d3359a0415d7bc8798411483a9f47c75ff3)]:
  - @ifc-lite/wasm@1.20.0

## 1.22.2

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
  - @ifc-lite/wasm@1.19.2

## 1.22.1

### Patch Changes

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

- [#815](https://github.com/LTplus-AG/ifc-lite/pull/815) [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937) Thanks [@louistrue](https://github.com/louistrue)! - Fix invalid WebGPU pipeline error on the 2D section overlay line pipeline.
  After [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) the line pipeline carried `depthBias` / `depthBiasSlopeScale` /
  `depthBiasClamp` alongside `topology: 'line-list'`, which the WebGPU spec
  rejects ("Depth bias is not compatible with non-triangle topology
  LineList"). The invalid pipeline then surfaced a second error on every
  `set_pipeline` for section cut outlines and 3D annotation lines.

  The depth-bias fields are removed from the pipeline and the equivalent
  reverse-Z decal nudge is now applied directly in the line vertex shader
  (`clip.z + 5e-5 * clip.w`), preserving the [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) coplanar-line fix while
  producing a valid WebGPU pipeline.

- Updated dependencies [[`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84), [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3)]:
  - @ifc-lite/wasm@1.19.1

## 1.22.0

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

- Updated dependencies [[`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec)]:
  - @ifc-lite/wasm@1.19.0

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
