# @ifc-lite/geometry

## 2.13.1

### Patch Changes

- 1b148c1: Fix walls being sliced flat at a height (gable/roof top removed, windows left
  floating) after #1440. The malformed-void-cutter detector (`opening_obb_if_malformed`)
  flagged ANY cutter with a vertex >4 m beyond its near vertex cluster as "garbage".
  A legitimate roof/gable cut — a watertight prism authored to reach far up (e.g.
  ~900 m) to clip a wall down to the roofline — trips that test on its structural
  top vertices, so the real cut was skipped and replaced by a horizontal slab,
  slicing every roof-capped wall flat.

  Gate the detector on a closed-manifold check: a cutter that welds (by position)
  to a closed 2-manifold is a VALID SOLID and is never reshaped, so roof/gable
  prisms and clean opening boxes are spared. Only genuinely broken cutters
  (self-intersecting / fin-laden tessellated voids, which leave boundary or
  non-manifold edges) still get the #1440 repair. The spike/flap regression
  (`multi_body_void_spike`) and the full geometry suite stay green; output matches
  the pre-#1440 (correct) result byte-for-byte on the reported model.

## 2.13.0

### Minor Changes

- 24e1648: Make the Rust-backed exporters reliable on large and degenerate inputs.

  Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
  STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
  single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
  immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
  `0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
  than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
  ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
  existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
  and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

  Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
  `Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
  exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
  at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
  string cap) is the practical ceiling for the very largest models.

  Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
  matched entities carry no triangulated geometry) produced a structurally valid GLB with
  zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
  reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
  `@ifc-lite/export`).

  Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
  buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
  builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
  length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.

- 7c45192: Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

  The from-bytes GLB assembler baked every element occurrence in full, so a model with
  hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
  referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
  exporter now reuses the same representation-identity collation the GPU/native
  instancing path uses: each repeated shape is emitted ONCE and every occurrence is
  placed with a glTF node matrix carrying its world pose.

  Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
  placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
  basis change, then folded against the model-wide scene centre before the single f32
  downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
  pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
  offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
  coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
  model-relative, f32-precise translation even at national-grid scale.

  Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
  so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
  singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
  every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
  one synthetic with a rotated instance at national-grid coordinates.

  Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
  bake (no node transform), so a consumer that ignores node transforms still sees them
  correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
  baked meshes share one mesh placed by a node translation), so the output never regresses
  below the prior per-occurrence baseline on models without representation-level repeats.

  Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
  schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
  byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
  instancing side-channel and falls back to the flat content-hash dedup).

- 4f76955: Decouple the small-cut skip (#1286) from the tessellation tier and use it for the
  viewer's on-screen load.

  `GeometryProcessor` gains a `skipSmallCuts` option (and the WASM `IfcAPI` a
  `setSkipSmallCuts` binding) that drops tiny `IfcBooleanResult` detail cuts (steel
  copes/notches) WITHOUT lowering the tessellation tier, so curved geometry keeps
  full density while the dominant boolean-heavy load cost is skipped. The viewer
  enables it for the streaming display load (boolean-heavy steel models reach
  Manifold-class first paint); exporters and drawings leave it off, so their
  geometry keeps every cut. Default off everywhere else, so all other output stays
  byte-identical.

- 909c1b0: Add a typed `GeometryDiagnostics` contract for CSG / opening diagnostics.

  The WASM batch path already computed a rich CSG / opening diagnostic summary
  (opening classification, per-reason failure breakdown, per-host detail, silent
  rectangular no-op detection, rect_fast fast-path engagement) and then discarded it,
  logging only to the browser console. A package consumer could not subscribe to it
  without scraping console output.

  This surfaces it as a typed, serializable contract:

  - `rust/geometry` exposes a `GeometryDiagnostics` struct and a wasm-free
    `aggregate_diagnostics` built from the drained router data, so the same shape is
    producible on the WASM and native paths from a single drain.
  - The WASM `MeshCollection` exposes the per-batch `diagnostics` as a JS object
    (replacing the earlier two scalar getters).
  - `@ifc-lite/geometry` exports the `GeometryDiagnostics` type and
    `mergeGeometryDiagnostics`, and surfaces a per-load `diagnostics` object on the
    streaming `complete` event: the geometry worker merges per-batch diagnostics
    across batches and the parallel loader merges across workers, logging one
    aggregate console summary.
  - The viewer reads `event.diagnostics` and logs a concise summary when CSG failures
    or silent no-ops occur; the full typed object rides the streaming event for a UI
    or telemetry consumer to subscribe to.
  - Native parity: the `rust/processing` geometry pass drains opening classification +
    per-host diagnostics from each per-element router and aggregates them through the
    same `aggregate_diagnostics`, attaching the full contract to
    `ProcessingStats.geometry_diagnostics` (the WASM bundle and the server emit it). The
    native streaming bridge forwards it onto the viewer `complete` event, so the
    native-only deployed viewer surfaces the same diagnostics as the WASM path, and
    `@ifc-lite/server-client` types it on the stats response.
  - CLI / SDK surface: a new wasm `diagnoseGeometry(bytes)` binding runs the same
    `process_geometry` pass and returns only its `GeometryDiagnostics`, exposed as
    `GeometryProcessor.diagnoseGeometry` and an `ifc-lite diagnose-geometry <file.ifc>`
    command (human-readable report, or `--json` for the raw contract).

  `totalCsgFailures` and the classification counts are exact; `productsWithFailures`,
  `hostsWithOpenings` and `silentNoOps` are batch-summed upper bounds.

### Patch Changes

- e6bd2dd: Cap the number of void cutters packed into a single CSG arrangement, fixing a
  geometry-stream stall on models with elements that carry many openings.

  `subtract_mesh_many` previously subtracted every disjoint cutter of a host in ONE
  N-ary conforming arrangement. That arrangement's cost is super-linear in the
  cutters packed into it, so an element with ~90 openings cost ~12 s in a single
  arrangement (vs ~0.4 s chunked, 30x). On WASM that single element alone exceeded
  the 40 s geometry-stream watchdog: an 86 MB model that loaded in ~15 s natively
  stalled and failed to load in the browser. Because the per-element escalation
  budget bounds escalations, not the base arrangement size, it did not catch this.

  Void cutters here are order-free (set difference: `host − {all} ≡ host − {chunk₁}
− {chunk₂} − …`), so the cutters are now processed in chunks of 16, bounding the
  per-arrangement cost so no single element can stall the stream. It is
  solid-equivalent (the batch path's contract is volume parity + watertightness,
  not byte-identical tessellation; the existing `subtract_many_*_matches_sequential`
  equivalence tests and a new 20-cutter chunked-equivalence test all pass, and the
  full geometry suite is unchanged). For hosts with <= 16 cutters this is exactly
  the prior single arrangement. Verified end to end: the previously-stalling model
  now loads completely and renders correctly.

  Bumps the geometry cache `FORMAT_VERSION` (10 → 11). For a host with > 16 void
  cutters the chunked cut is solid-equivalent but not byte-identical (and on
  pre-fix builds those hosts often fell back to an AABB box), so the mesh hash
  changes. The bump invalidates pre-fix caches so restored models re-mesh with the
  correct tessellation, and the compare/diff feature does not flag those hosts from
  a stale-cache hash mismatch.

- f9f0784: Fix GLB export collapse on georeferenced models with rotated instanced occurrences.

  The GPU-instancing collator built each occurrence's relative transform as
  `rel = m_k · m_ref⁻¹` on the **pre-RTC** (absolute, georeferenced-magnitude)
  placements stored in `InstanceMeta.transform`, while the baked template `origin`
  is **post-RTC** (small). For an occurrence rotated relative to its template,
  `rel.translation = T_k − R_rel·T_ref` — and when the rotation flips an axis the
  two ~1e6 m terms _add_ instead of cancel, reaching **2× the georeference**. The
  renderer then applies that to the small template origin, so those occurrences fly
  out to twice the site offset. On a georeferenced model (e.g. EPSG:4326 rebar) this
  dragged the GLB exporter's scene-center to ~6e6 m and re-snapped every f32 vertex
  to a ~0.5 m grid, collapsing the whole model on export / re-import.

  `collate_refs` now takes the applied RTC and reduces both composed transforms to
  the post-RTC frame before forming the relative transform, so the offset cancels
  exactly regardless of rotation and the relative translation stays at building
  scale (consistent with the small template origin the renderer applies it to). The
  `processGeometryBatchInstanced` shard path passes the real RTC; the from-bytes
  glTF exporter passes `[0,0,0]` because it already conjugates by RTC per occurrence
  downstream. Non-georeferenced models (RTC `[0,0,0]`) are unchanged.

  Verified end to end: instanced occurrences for a georeferenced model now stay at
  building scale (was ~1.2e7 m), the viewer GLB export is precise (±9 m, was ±6e6 m
  collapsed), and the export → re-import round-trip is geometrically intact.

- 6eb46f1: Right-size the geometry worker pool: narrow the small-file fast path from 8-64 MB
  to <= 24 MB.

  A 10-core browser worker-count sweep found the 8-64 MB `cores - 2` band (#1258)
  over-provisioned workers for decode- and heavy-tail-bound models in the 24-64 MB
  range. Because each worker is a separate WASM instance that re-decodes the file
  into its own heap and rebuilds the entity index, 8 workers ran 20-30% SLOWER than
  4 at up to ~5x the peak WASM memory (e.g. ~882 MB vs ~161 MB on a 54 MB model).
  Measured improvements at the new auto-selected count: a 34 MB heavy-tail model
  7.2s -> 5.7s (-21%), a 54 MB decode-bound model 14.4s -> 11.7s (-19%) at roughly
  half the peak memory. Genuinely small compute-bound steel (a 20 MB model with
  ~26k boolean jobs) still benefits from `cores - 2` (17.0s vs 22.9s at 4 workers),
  so the fast path is kept for <= 24 MB where the per-worker re-decode/memory cost
  is low; > 24 MB now falls through to the existing per-core bandwidth cap (4 on a
  10-core host). The > 512 MB bandwidth caps and the memory-budget cap are
  unchanged. A fully workload-aware count (using the real prepass job/CSG density
  instead of the file-size proxy) is a follow-up.

- 3f25a72: Fix two rendering defects from malformed self-intersecting tessellated void
  cutters (window/door openings authored as `IfcPolygonalFaceSet` whose point list
  carries garbage vertices metres from the real opening, plus a sibling multi-body
  extruded cutter). The exact mesh-arrangement kernel mishandles such cutters two
  ways, both fixed without touching the cut path:

  - A far-flung "fin" triangle leaked into the host output as a multi-metre spike
    poking out of the wall, surfacing only under the multi-cutter arrangement (so
    it slipped past the per-cutter admission guards). A boolean subtract can only
    REMOVE material, so the result is contained in the host's pre-cut AABB; any
    output triangle reaching beyond it is provably an artifact and is now dropped
    (`Mesh::clip_triangles_to_aabb`, which also compacts the orphaned vertices so
    bounds/picking/clash/export stay correct).

  - The same cutters made the kernel UNDER-cut, leaving a wall flap bridging the
    opening on the wall face. For each cutter detected as malformed (intrinsic
    vertex clustering, since a fin running along a long wall stays inside its
    AABB), the real opening box is recovered and wall triangles overlapping its
    cross-section are dropped (`clip_opening_flaps`), sparing the reveal/jamb
    faces on the boundary.

  Both passes are gated to provably-broken cutters and are a no-op on clean
  openings, so well-formed models are byte-identical.

- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
  - @ifc-lite/wasm@2.14.0

## 2.12.0

### Minor Changes

- [#1409](https://github.com/LTplus-AG/ifc-lite/pull/1409) [`76b6a4f`](https://github.com/LTplus-AG/ifc-lite/commit/76b6a4fd1c6f3710127e402c11636917a338ce38) Thanks [@louistrue](https://github.com/louistrue)! - Fix measure-snap missing all-but-one occurrence of GPU-instanced geometry ([#1405](https://github.com/LTplus-AG/ifc-lite/issues/1405)). `Scene.getInstancedMeshDataPieces` materializes one `MeshData` per instanced occurrence, all stamped with the same `expressId` but holding distinct world-space positions. `SnapDetector` cached the deduped vertices/edges/valence keyed on `expressId` alone, so the first occurrence's geometry was served for every later one (whose true world positions are elsewhere) and snap fell back to a free-point face hit — vertex/edge snapping lit up on only a single instance while raycast (which is cache-free) kept working on all of them. Materialized occurrences now carry a stable per-occurrence `occurrenceKey` (new optional field on `MeshData`), and the snap geometry cache keys on `occurrenceKey ?? expressId`, so snap works on every occurrence and the cache no longer collides instanced pieces with a flat mesh of the same `expressId`.

### Patch Changes

- Updated dependencies [[`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4)]:
  - @ifc-lite/wasm@2.13.4

## 2.11.0

### Minor Changes

- [#1382](https://github.com/LTplus-AG/ifc-lite/pull/1382) [`f1d6720`](https://github.com/LTplus-AG/ifc-lite/commit/f1d672054e4afa246b851d25fffc91604f9f0507) Thanks [@louistrue](https://github.com/louistrue)! - Detect and broadcast the "stale deployment" WASM-asset failure so hosts can recover from version skew. When a production deploy rotates the content-hashed `ifc-lite_bg-<hash>.wasm` under a still-open tab, the lazy fetch 404s (served as `text/plain`) and `WebAssembly.instantiateStreaming` throws `Response has unsupported MIME type 'text/plain' … expected 'application/wasm'` — the engine never initializes ([#1363](https://github.com/LTplus-AG/ifc-lite/issues/1363)). A same-URL retry can't recover a rotated asset, so the geometry engine now classifies this case (`isWasmAssetUnavailableError`) and dispatches a `WASM_ASSET_UNAVAILABLE_EVENT` on `globalThis` at its init choke points (the main-thread `GeometryProcessor.init` and the worker-pool error handlers). The library never reloads the page itself; an opted-in host (the viewer) listens and reloads once onto the current deployment.

### Patch Changes

- [#1385](https://github.com/LTplus-AG/ifc-lite/pull/1385) [`da89f45`](https://github.com/LTplus-AG/ifc-lite/commit/da89f45e47aa1ba96f83bc0abb04310cef2260ef) Thanks [@louistrue](https://github.com/louistrue)! - Fix wall openings rendering filled when a single `IfcOpeningElement` carries a row of separate void bodies ([#1367](https://github.com/LTplus-AG/ifc-lite/issues/1367)). The void router merged every body of such a high-vertex opening into one cutter and subtracted them in a single arrangement, which left diagonal "bridge" triangles spanning some of the holes. An opening is now split into one cutter per body when its bodies form 2 or more disjoint spatial clusters, so each window is cut on its own. Bodies that touch or overlap (one void split into adjacent parts, e.g. inner/outer wall-leaf halves of a window) still subtract merged, so the gable-wall watertightness path is unchanged.

## 2.10.1

### Patch Changes

- [#1340](https://github.com/LTplus-AG/ifc-lite/pull/1340) [`0b73ebb`](https://github.com/LTplus-AG/ifc-lite/commit/0b73ebb785d378651e063ace128ad097991ccfb6) Thanks [@louistrue](https://github.com/louistrue)! - Fix two void-cut over-cuts on walls with direction-less (e.g. FreeCAD/brep) openings ([#1337](https://github.com/LTplus-AG/ifc-lite/issues/1337)):

  - Two rectangular openings on perpendicular walls whose world AABBs cross at a building corner were merged into one phantom bounding box and punched a hole through both walls. The opening merge now fires only when the two boxes coincide on at least two axes (so `bbox(A,B) == A ∪ B`, no phantom volume), which still collapses the aligned/tiled openings the merge exists to optimize.
  - A deep box opening (cutter deeper than the wall is thick) had its through-host penetration axis guessed as its thinnest AABB axis, which for such cutters is in-plane rather than through-wall. The cap-flush extension then ran along the wrong axis and latched onto a neighbouring void's reveal facet, growing the hole ~0.3 m on later-cut openings. The penetration axis is now inferred from the axis along which the opening pierces past the host, falling back to thinnest only for genuinely flush cutters.

- Updated dependencies [[`c7c58c0`](https://github.com/LTplus-AG/ifc-lite/commit/c7c58c09e40fe40be5cc14cadf95beac18130ea5), [`18187fa`](https://github.com/LTplus-AG/ifc-lite/commit/18187facd6fa6fec15a23ef5e3263353730c5d8b)]:
  - @ifc-lite/wasm@2.13.2

## 2.10.0

### Minor Changes

- [#1322](https://github.com/LTplus-AG/ifc-lite/pull/1322) [`9544b4d`](https://github.com/LTplus-AG/ifc-lite/commit/9544b4d4c2b3502994d59f4af13cfb1661e87044) Thanks [@Blogbotana](https://github.com/Blogbotana)! - GLB export: add a `lit` option (default `true`) so exported models render with
  standard PBR lighting in external viewers instead of flat `KHR_materials_unlit`.
  `GeometryProcessor.exportGlb(.., lit?)` and `exportGlbFromMeshes(meshes, includeMetadata?, lit?)`
  now emit lit materials by default; pass `lit: false` for the previous flat,
  apparent-colour look. Normals were always written — only the unlit material
  extension suppressed shading. ([#1321](https://github.com/LTplus-AG/ifc-lite/issues/1321))

### Patch Changes

- Updated dependencies [[`9544b4d`](https://github.com/LTplus-AG/ifc-lite/commit/9544b4d4c2b3502994d59f4af13cfb1661e87044)]:
  - @ifc-lite/wasm@2.13.0

## 2.9.2

### Patch Changes

- [#1292](https://github.com/LTplus-AG/ifc-lite/pull/1292) [`84c9f6e`](https://github.com/LTplus-AG/ifc-lite/commit/84c9f6e09eba2747b37da8f74aa7de23cb9f96d3) Thanks [@louistrue](https://github.com/louistrue)! - Fix GPU instancing dropping repeated geometry ("missing objects" under [#1238](https://github.com/LTplus-AG/ifc-lite/issues/1238)).

  The sub-mesh placement path (`apply_submesh_placement`) — taken by every
  multi-item element, which is all Tekla-style steel (beams, plates, assemblies)
  — baked the element's world placement into the vertices but never recorded it
  into `instance_meta.transform`, leaving the IDENTITY placeholder. The single-mesh
  path (`apply_placement`) already records it; the sub-mesh path did not. So
  `collate_refs` computed `rel_k = m_k · m_ref⁻¹ = identity` for every occurrence
  of a template and they all stacked on the first one, leaving every other position
  empty. The flat (non-instanced) path was always correct, and content-dedup made
  it look like ~half the model was gone. Now each sub-mesh records the scaled
  per-element placement before baking, mirroring the single-mesh path.

- Updated dependencies [[`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/wasm@2.11.1

## 2.9.1

### Patch Changes

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - GPU-instancing review follow-ups: reject truncated instanced-shard cache payloads
  and instances referencing missing templates; carry geometry-diff hashes for
  instanced-only entities so model compare still detects their changes; fix the
  raycast BVH to rebuild on a same-count-different-members instanced set and the
  instanced-piece dedup key collision; tombstone instanced-only entities on
  delete/split; wire instanced occurrences into the CPU enumeration / raycast
  paths; reset instancing metadata in Mesh::clear; guard verify_recomposition
  against vertex-count mismatches; validate the transparent-instanced pipeline via
  a GPU error scope.

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Add a decoder for the instanced ("IFNS") geometry shard format
  (`decodeInstancedShard`, `isInstancedShard`). It mirrors the Rust
  `encode_instanced`/`decode_instanced` codec and carries each unique template
  geometry once plus a per-occurrence instance row (transform + entity id +
  colour), so a future renderer path can upload a template once and GPU-instance
  its occurrences. Additive and unused by the default path; verified against a
  Rust-produced fixture (cross-language round-trip + expand-to-flat).

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Render genuinely-repeated opaque geometry via GPU instancing. The geometry worker
  now produces each batch once via `processGeometryBatchPartitioned`, which routes
  occurrences by per-batch repetition: a geometry whose `rep_identity` occurs at
  least `INSTANCE_MIN_OCCURRENCES` (8) times in the batch collapses to one template

  - per-occurrence transforms in a GPU-instancing shard; everything else
    (singletons, low-count, non-instanceable, plus all transparent / textured /
    type-template geometry) goes to the flat `MeshCollection` and is consolidated +
    frustum-culled exactly as before. This keeps the instancing upload/memory win for
    truly-repeated geometry (mullions, fasteners, identical parts) while keeping
    unique geometry on the cheap consolidated draw path — instancing every singleton
    as a 1-instance template would issue one draw call per mesh and tank orbit
    framerate. The shard is posted as `instancedShards`, decoded, and GPU-instanced;
    picking, selection highlight, and colour overlays (lens / IDS / compare / 4D) all
    operate per-instance, so the instanced path is at feature parity with the flat
    path. The streamed mesh total counts both routes. Falls back to the flat-only path
    when the loaded wasm predates the partitioned export.

- [#1259](https://github.com/LTplus-AG/ifc-lite/pull/1259) [`b125ae6`](https://github.com/LTplus-AG/ifc-lite/commit/b125ae60f0a7227ea42dfb0f95230e29c7f645ff) Thanks [@louistrue](https://github.com/louistrue)! - Fix oversized, fragmented openings cut from walls rotated in plan ([#1167](https://github.com/LTplus-AG/ifc-lite/issues/1167), "weird
  wall hole cutting").

  A vertical wall rotated in plan (a façade off the project grid, or a whole
  building rotated relative to the world axes) had its windows and doors cut
  wrong: the openings came out far larger than they should and the wall fragmented
  into rim slivers and cracks. On a real reporter model the worst wall lost 86% of
  its volume to five openings and came back with ~236 unpaired edges. Two causes,
  both from cutting a _tilted_ opening box in _world_ space:

  - The opening was routed onto the fast world-axis-aligned-AABB cut path whenever
    its extrusion direction sat within ~18° of a world axis (the
    `is_axis_aligned_direction` tolerance of 0.95). The AABB of a rotated box is
    strictly larger than the box — an oversized, grid-aligned hole.
  - Even via the exact mesh subtract, a tilted cut at large world coordinates
    (≈150 m, where f32 ≈ 15 µm) over-cuts and fragments.

  The tolerance is tightened to `cos(1°)`, and — the real fix — a plan-rotated
  wall is now cut in its own axis-aligned, origin-centred frame: the host and its
  openings are rotated into that frame (where they are world-axis-aligned and near
  the origin, so the exact subtract is clean and f32-precise), cut there (clean
  boxes take the watertight `rect_fast` path; brep/curved openings keep their
  mesh), then the result is rotated back. A rotated wall now cuts like a straight
  one — the right volume, watertight, no slivers — at any rotation angle. The path
  is tightly scoped to plan-rotated walls, so axis-aligned walls and
  roof/floor/sloped openings are untouched.

  Adds regression tests: `rotated_wall_opening_is_not_overcut` and
  `rotated_opening_cuts_clean_at_every_angle` (synthetic, 3–45°, clean and
  tessellated profiles), plus `rotated_wall_openings_not_overcut_or_fragmented`,
  pinned on a real `IfcWallStandardCase` isolated from the reporter's model (five
  openings, full placement chain) — 22.5 m³ over-cut + 236 unpaired edges before,
  ~13 m³ and watertight after.

- [#1258](https://github.com/LTplus-AG/ifc-lite/pull/1258) [`7f5e543`](https://github.com/LTplus-AG/ifc-lite/commit/7f5e543fee7b8f92109bf1b581120f3571f1e445) Thanks [@louistrue](https://github.com/louistrue)! - Give small, compute-bound IFC files more geometry workers on active-cooled
  (10+ core) machines. The per-core caps were tuned to a bandwidth ceiling
  measured on a >512 MB georef result, but small models (e.g. a 20 MB
  boolean-clipped steel file) are CPU-bound, not bandwidth-bound — the 3–4
  worker cap left most cores idle. Files ≤64 MB now scale to `cores-2` workers
  (memory budget and `?geomWorkers=N` override still apply).

## 2.9.0

### Minor Changes

- [#1242](https://github.com/LTplus-AG/ifc-lite/pull/1242) [`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722) Thanks [@louistrue](https://github.com/louistrue)! - Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
  source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
  native-only ara3d BOS/Parquet path). They are exposed via wasm
  (`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
  reachable from TypeScript through `GeometryProcessor.export*` and
  `IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
  emits it as a node translation, keeping f32 vertex precision at georef scale).

  STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
  renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
  payload (`MutablePropertyView` attribute edits + property-set synthesis: new
  `IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
  **IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
  IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
  id-offset + project unification).

  The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
  `--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
  `#`-reference closure is added so a filtered export never dangles a reference; `--schema`
  converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
  and a new `export_obj` tool is added (all honour an optional `type` filter).

  Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
  the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
  strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
  headless `clash`/geometry commands that previously failed to initialize wasm in Node.

  The viewer's GLB export now assembles the binary in Rust over the meshes it already
  holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
  TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
  translation so georef-scale models keep vertex precision.

  **BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
  (+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
  `GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
  `exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
  callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
  generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.

- [#1247](https://github.com/LTplus-AG/ifc-lite/pull/1247) [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e) Thanks [@louistrue](https://github.com/louistrue)! - Move the KMZ (Google Earth) exporter to Rust. The `ifc-lite-export` crate now
  assembles the KMZ archive (`doc.kml` + `model.glb`) and computes the IFC
  grid-north → KML heading, exposed via the wasm `exportKmz` binding and
  `GeometryProcessor.exportKmz`. The viewer's `buildKmz` is now a thin async caller
  (matching the OBJ/glTF/CSV pattern); the GLB it packages is already produced by the
  Rust GLB exporter. The archive uses a hand-rolled stored-ZIP writer so the wasm
  bundle pulls in no zip/deflate dependency.

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/wasm@2.11.0

## 2.8.0

### Minor Changes

- [#1235](https://github.com/LTplus-AG/ifc-lite/pull/1235) [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384) Thanks [@louistrue](https://github.com/louistrue)! - Add HBJSON (Honeybee / Ladybug Tools energy & daylight model) export.

  `ifc-lite export <file.ifc> --format hbjson` and `GeometryProcessor.exportHbjson(buffer, name)`
  produce a Honeybee-valid model: `IfcSpace` volumes become watertight, planar-faced Rooms
  (Floor / RoofCeiling / Wall) ready to load via `Model.from_hbjson` and run in Ladybug Tools /
  Pollination. `IfcWindow` and `IfcDoor` occurrences are placed as coplanar Apertures and Doors
  on the matching exterior walls. Rooms and openings are built analytically from extruded-area
  profiles (not the render mesh), so they are watertight by construction and wasm-safe.
  `IfcRailing` occurrences are emitted as shading `ShadeMesh` geometry, and `IfcMaterialLayerSet`
  build-ups become Honeybee opaque constructions (real layer names + thicknesses; thermal
  properties defaulted by material-name keyword, since IFC rarely carries them) assigned by face
  type. Shared interior walls are paired as `Surface` adjacencies so multi-zone energy models
  don't lose heat to ambient. Backed by a new pure-Rust `ifc-lite-export` crate (source of truth
  for CLI / SDK / wasm). Available in the viewer's export menu as "Export HBJSON (Energy Model)",
  on the CLI as `export --format hbjson`, and via the SDK as `bim.export.hbjson()` (delegated to a
  geometry-capable backend; the data-only SDK stays wasm-free).

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb), [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384)]:
  - @ifc-lite/data@2.2.0
  - @ifc-lite/wasm@2.10.0

## 2.7.10

### Patch Changes

- [#1216](https://github.com/LTplus-AG/ifc-lite/pull/1216) [`744f9f8`](https://github.com/LTplus-AG/ifc-lite/commit/744f9f8796a6e8cdcdfb586c47e9019ea7813208) Thanks [@louistrue](https://github.com/louistrue)! - Emit a meaningful message when a geometry worker crashes. A hard worker crash
  (e.g. the wasm thread aborting under memory pressure) fires an `ErrorEvent`
  with an empty `message`, so the pool reported the cryptic, unclassifiable
  "Geometry worker failed: undefined". It now synthesises a message from
  whatever the `ErrorEvent` carries (`filename:lineno`, or
  "worker terminated unexpectedly"), so the failure is human-readable and the
  viewer's load-error classifier can bucket it instead of filing it as a raw
  one-off error.
- Updated dependencies [[`249761a`](https://github.com/LTplus-AG/ifc-lite/commit/249761ab7f1d51ce46b3058b595a6fad7c26db7e)]:
  - @ifc-lite/data@2.1.1

## 2.7.9

### Patch Changes

- [#1185](https://github.com/LTplus-AG/ifc-lite/pull/1185) [`23a36a6`](https://github.com/LTplus-AG/ifc-lite/commit/23a36a66dfcfbd9bef2b988094c003b17d400d76) Thanks [@louistrue](https://github.com/louistrue)! - Cut time-to-first-geometry roughly in half on large models by reordering the streaming pre-pass.

  Content-affinity routing had deferred all job emission to the very end of the pre-pass — the per-job geometry-hash pass, plus the entity-index event being emitted last, left the geometry workers idle until the whole pre-pass finished. The pre-pass now ships the events workers gate on (entity-index + styles) and a small first job wave right after the scan, then runs affinity routing over the rest. On a ~50k-part model first-visible-geometry dropped from ~22s to ~12s with no change to total load time or geometry — the bulk keeps exact geometry-hash affinity; only the small first wave routes by element id.

- [#1190](https://github.com/LTplus-AG/ifc-lite/pull/1190) [`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf) Thanks [@louistrue](https://github.com/louistrue)! - Recover from transient WASM engine-load failures and humanise the error.

  When the `ifc-lite_bg.wasm` binary fails to download (non-OK HTTP status, a cold
  CDN edge, a mid-deploy race, or a blocking proxy/antivirus), wasm-bindgen's
  streaming loader rethrows a cryptic `Failed to execute 'compile' on
'WebAssembly': HTTP status code is not ok`. The geometry and parser workers now
  retry `init()` once on such fetch/HTTP-shaped failures, and the viewer maps the
  failure to actionable guidance ("reload the page") instead of surfacing the raw
  TypeError. Captured exceptions are tagged with a stable `error_kind` for triage.

## 2.7.8

### Patch Changes

- [#1181](https://github.com/LTplus-AG/ifc-lite/pull/1181) [`9d579cf`](https://github.com/LTplus-AG/ifc-lite/commit/9d579cfca7e5f3c8a37c57b494c7b944a296afc0) Thanks [@louistrue](https://github.com/louistrue)! - Skip rayon for small BReps — the fork-join overhead dwarfs the trivial triangulation.

  `FacetedBrepProcessor` dispatched every shell's face triangulation through rayon `par_iter`, but real-world BReps are overwhelmingly tiny (6–50 faces of trivial tri/quad/convex fast-path geometry — e.g. Tekla steel detail parts), where the parallel fork-join dispatch costs far more than the work it parallelises. A serial path gated on a 64-face threshold avoids that overhead (and the nested-parallelism contention under the per-element worker pool); `par_iter` still runs for large shells. Output is byte-identical — `collect` preserves index order and each face's f32 result is unchanged.

  Measured native, byte-identical (strict mesh hash unchanged): a 48k-BRep structural model −16.6% geometry time, an architectural BRep-heavy model −37%. Scales with how many small shells a model has; the win is larger in the browser where the nested parallelism is more expensive.

- [#1184](https://github.com/LTplus-AG/ifc-lite/pull/1184) [`4a649b0`](https://github.com/LTplus-AG/ifc-lite/commit/4a649b0ced07331e3f2306f8462c5ee354b004c8) Thanks [@louistrue](https://github.com/louistrue)! - Re-enable content-dedup on the production geometry paths with a cheap structural hash — it's now a net speedup on steel-heavy models instead of the slowdown that forced it off.

  Content-dedup (skip re-meshing structurally-identical representation items) was disabled in the previous release because its 128-bit structural key recursively decoded the _entire_ item subtree — every face, loop, and point — costing more than the meshing it saved. `item_signature` now hashes `IfcFacetedBrep` (the dominant type in Tekla steel exports, where thousands of geometrically identical plates and bolts each get their own representation) through the same cached byte-level fast paths the mesher uses, with zero `decode_by_id` per point. On a ~50k-part steel model the brep hash dropped from ~8 s to ~2 s — below the ~5 s of meshing it skips — flipping dedup from a 0.9× loss to a 1.3× win, with byte-identical geometry (0 fingerprint mismatches over 50k elements).

  Dedup is gated to the cheap (brep) types in `item_dedup_key`, so procedural-geometry models — the ones whose recursive hash cost more than it saved — skip the hash entirely and pay nothing. The separate `IfcMappedItem` instancing cache is unaffected.

## 2.7.7

### Patch Changes

- [#1177](https://github.com/LTplus-AG/ifc-lite/pull/1177) [`f5901b8`](https://github.com/LTplus-AG/ifc-lite/commit/f5901b8c32d401d57c8d38bcc8d3b14b423a3784) Thanks [@louistrue](https://github.com/louistrue)! - Default content-dedup OFF on the production geometry paths — it was making large-model loads slower, not faster.

  The item-level content-dedup (skip re-meshing structurally-identical representation items) builds its 128-bit structural key by recursively decoding the _entire_ item subtree (every face, loop, and point entity) with the general decoder — roughly 3.5× more work than the mesher's cached decode of the same item. On real models the hash therefore costs more than the meshing it skips: measured on two large structural models, loads were **20–30% slower** with dedup on (it only paid off at near-100% duplicate hit-rate). Gated both production batch paths (native rayon pool + wasm) behind `GeometryRouter::content_dedup_enabled()` (default `false`); geometry output is byte-identical. The separate `IfcMappedItem` instancing cache is unaffected. A follow-up will make the structural hash walk the cached fast paths so dedup can be re-enabled as a net win.

## 2.7.6

### Patch Changes

- [#1160](https://github.com/LTplus-AG/ifc-lite/pull/1160) [`631511e`](https://github.com/LTplus-AG/ifc-lite/commit/631511eedb135ea8bfc7caf640edea8862b86a59) Thanks [@louistrue](https://github.com/louistrue)! - Restore per-layer slicing of single-solid walls/slabs with an `IfcMaterialLayerSetUsage`. Slicing turns one solid into one coloured sub-mesh per material layer (geometry_id = the layer's `IfcMaterial`) so the build-up is visible in 3D. The "Merge Multilayer Walls" toggle now does what its label promises for these walls too — "render walls as one solid": with the toggle on, the layer index is not attached, so each wall stays a single swept solid instead of slicing into layers (off, the default, shows the layered build-up).

  The slicing kernel stayed intact, but [#874](https://github.com/LTplus-AG/ifc-lite/issues/874) (mesh-production unification) dropped the `set_material_layer_index` wiring from every pipeline, so the router's index was always `None` and `try_layered_sub_meshes` never fired — layered walls silently rendered as a plain single solid in the browser, native, and server paths. Re-wire it: build the `MaterialLayerIndex` once per load (cached on the IfcAPI for the streaming path, with a cheap substring bail-out so files with no layer set pay nothing) and attach it to every batch router. This also restores the "Merge Multilayer Walls" toggle for models whose sliceable walls carry their geometry as `IfcBuildingElementPart`s — the merged parent now actually draws its sliced solid instead of leaving a gap.

  2D section now shows the layers too. The section cutter carries each sub-mesh's colour onto its cut segments (CPU and GPU paths), and the polygon builder splits one entity's cut into a polygon per material colour — single-material elements still produce one colourless polygon, so their existing per-`ifcType` / per-entity fill is unchanged. When the viewer shows IFC materials, each sliced layer fills with its own `IfcMaterial` colour instead of one colour for the whole wall, and the layer divisions are drawn as outlines — matching the 3D build-up.

  Two follow-on robustness fixes:

  - **3D layer glitch (z-fighting).** Adjacent layer slabs share the parent wall's `expressId`, so the renderer's per-entity depth nudge (keyed on `entityId`) gave their coincident interior interface caps the SAME depth — under `cullMode: 'none'` + MSAA that z-fought into a flickering comb that read as "see inside / not solid". The shader now folds the per-draw `baseColor` into the depth-nudge hash; batches are keyed by colour, so abutting layers (distinct colours) land on distinct depths. Constant per draw, so flat faces stay flat and curved surfaces are unaffected.

  - **Cap watertightness on irregular profiles.** A layer slab's innermost cut is built by two successive plane clips; on a non-convex `IfcArbitraryClosedProfileDef` the two passes deposit geometrically-coincident section vertices that differ by ~1 ULP. `cap_half_space_clip` welded by exact f32 bits, so those twins stayed separate, the boundary chain dead-ended and a cap sub-loop was silently dropped — leaving open edges (a hole you could see through and a section with no fill there). The cap now welds on a spatial grid tied to its on-plane tolerance, collapsing the twins so the loop closes. Single-plane callers (opening cuts) have no such twins and are unaffected.

  - **3D section cut read hollow.** The live 3D section cap (`Section2DOverlayRenderer`) filled each cut polygon with a naive convex fan over the outer ring only, ignoring holes — a long-standing KNOWN LIMITATION. On the concave cross-sections that arbitrary IFC profiles (and material-layer slabs) cut into, the fan inverts and leaves the cut face uncovered, so a sectioned wall read as a hollow shell. The fill now uses the renderer's existing hole-aware ear-clipping (the same one the annotation-fill path uses), so the cut face is solid. The cap also now honours a per-polygon colour: a material-layer wall fills each layer of its 3D section cut with that layer's `IfcMaterial` colour (matching the 3D solids and the 2D section), while single-material cuts keep the uniform cap style + hatch unchanged via a sentinel.

  - **Solid layered 3D walls via backface culling.** Rendering a material-layer wall as N thin coincident-faced layer solids made it shimmer / read as a hollow shell — adjacent layers' interface caps z-fight under the viewer's double-sided rendering (culling is globally off because general IFC winding is unreliable), and same-material adjacent layers can't be depth-separated. The layer slices DO have reliable outward winding, though, so they're now tagged `geometryClass` 3 and the renderer draws that class with a dedicated **backface-culling** pipeline: the build-up stays visible on the wall's faces and edges, but the interior coincident caps never rasterise, so the wall reads as a clean solid (and a section cut through it shows the interior material surface rather than a hollow shell). The 2D/section cut consumes the same class — it never culls — for its per-layer fills. Cache `FORMAT_VERSION` → 9 so stale caches re-mesh with the class-3 slices.

## 2.7.5

### Patch Changes

- [#1159](https://github.com/LTplus-AG/ifc-lite/pull/1159) [`39e0f82`](https://github.com/LTplus-AG/ifc-lite/commit/39e0f82558ec65dd574b6b4bfb2430f7abba346b) Thanks [@louistrue](https://github.com/louistrue)! - Add a `?geomWorkers=N` override for the geometry worker pool, and document the
  per-tier worker caps as a memory-bandwidth ceiling.

  The parallel geometry pool picks a worker count from a cores/memory heuristic.
  A `?geomWorkers=N` A/B sweep on a large (722 MB) georef model showed that, with
  the pure-Rust exact CSG kernel, geometry wall-time is bound by **memory
  bandwidth**, not CPU cores: 3→4→5 workers gave no geometry speedup (flat
  wall-time, higher peak memory) and progressively starved the co-running parser.
  So the existing caps are correct for this class of file and are left unchanged —
  only their rationale is updated in comments.

  The override (`?geomWorkers=N`, persisted to localStorage so it survives the
  reload a re-measure needs; `?geomWorkers=0`/`auto` clears it) lets a user measure
  their own host's optimum, since the bandwidth ceiling is hardware-specific. It is
  threaded to `computeWorkerCount`, which honours it but still clamps to the memory
  budget, so the knob can never OOM the tab. Geometry output is byte-identical
  across worker counts (verified in the wild: identical mesh count at 3 and 4
  workers) — the count only repartitions which worker meshes which disjoint,
  deterministic element slice.

- [#1169](https://github.com/LTplus-AG/ifc-lite/pull/1169) [`2556677`](https://github.com/LTplus-AG/ifc-lite/commit/25566773498f4761bb073e17b874e638208b7d13) Thanks [@louistrue](https://github.com/louistrue)! - Fix the rectangular-opening fast path erasing whole walls on redundant voids.

  Some authoring tools bake an opening into the wall profile AND re-add it as a
  separate opening element whose box spans the entire wall (a double-encoded /
  redundant void). The exact CSG kernel treats such a cutter as a no-op (its faces
  are coplanar with the host, so the host is returned unchanged), but the analytic
  `rect_fast` path was cutting it literally — removing the entire wall and leaving
  the window floating in a giant void ([#1167](https://github.com/LTplus-AG/ifc-lite/issues/1167)).

  `rect_fast` now detects any opening whose clamped box contains the whole host on
  all three axes and defers the element to the exact kernel, matching its
  behaviour. Genuine interior openings (a margin on any in-face axis) are
  unaffected and still cut analytically. Verified against ~1,500 void elements
  across 13 architectural models: the only fast-vs-exact divergence was this
  whole-wall case, now gone; every normal window already removed identical volume
  on both paths.

## 2.7.4

### Patch Changes

- [#1165](https://github.com/LTplus-AG/ifc-lite/pull/1165) [`9d9bd66`](https://github.com/LTplus-AG/ifc-lite/commit/9d9bd6646db8c40c797fe22d6eb4d60ee963c38c) Thanks [@louistrue](https://github.com/louistrue)! - Render `IfcSweptDiskSolid` elements whose directrix is an `IfcTrimmedCurve` (or bare `IfcLine`) — straight reinforcing bars, rods, and similar steel (issue [#1164](https://github.com/LTplus-AG/ifc-lite/issues/1164)).

  The 3D curve sampler had no `IfcLine` arm, so resolving a trimmed-line directrix returned "Unsupported curve type: IfcLine" and the swept-disk mesh collapsed to an empty mesh — the element silently failed to load. This is the common Tekla/IfcOpenShell encoding for a straight bar: `IfcSweptDiskSolid(IfcTrimmedCurve(IfcLine, 0., L, .PARAMETER.), r)`.

  The sampler now handles `IfcLine` directly and a trimmed `IfcLine` in full 3D, honoring Trim1/Trim2 (parameter or cartesian bounds) and SenseAgreement, so the directrix samples to its true `[start, end]` segment instead of erroring. The swept-disk processor also applies a solid's own `StartParam`/`EndParam` to a bare `IfcLine` directrix. The 2D curve path no longer errors on `IfcLine` either.

  The swept-disk mesh now also ships smooth per-vertex normals (computed in its small-coordinate directrix-local frame). It previously shipped empty normals, leaving consumers to recompute them from world-space f32 positions — which at a georef-scale placement (rebar at national-grid coordinates ~6 km from origin) cancel catastrophically into garbage normals, rendering the tube as a field of specular sparkles.

## 2.7.3

### Patch Changes

- [#1137](https://github.com/LTplus-AG/ifc-lite/pull/1137) [`69e5425`](https://github.com/LTplus-AG/ifc-lite/commit/69e5425e3d7586fcc2d44a33465806adc0ed53f8) Thanks [@louistrue](https://github.com/louistrue)! - Cap the cut face of unbounded `IfcHalfSpaceSolid` differences (gable roof-trims, mono-pitch eaves, Revit top-trims).

  The pure-Rust kernel consolidation ([#1024](https://github.com/LTplus-AG/ifc-lite/issues/1024)) deleted the in-tree BSP kernel along with the polygon cap that closed the cross-section left by the fast plane-clip path, but kept that path for unbounded `IfcHalfSpaceSolid` operands. With no cap, every such clip produced an **open, inverted shell** (negative signed volume, dozens of open boundary edges) instead of a watertight solid — the roof-clipped wall rendered as a broken/spiky surface.

  The clip now re-closes the section: it chains the on-plane open boundary into loops, classifies them into outer rings and holes, triangulates each region with the kernel CDT, and winds the cap to face the removed side. If the boundary is non-manifold or does not close (a non-watertight host), it bails and leaves the output unchanged — never worse than before.

  On AC20-FZK-Haus the two roof-clipped upper walls go from `14 tris / −8.4 m³ / 16 open edges` to `20 tris / +2.06 m³ / 0 open edges`; void-cut walls are untouched.

- [#1135](https://github.com/LTplus-AG/ifc-lite/pull/1135) [`bd585c7`](https://github.com/LTplus-AG/ifc-lite/commit/bd585c73de1f39db3c9aac168174012b98b79855) Thanks [@louistrue](https://github.com/louistrue)! - Speed up the exact CSG kernel ~42% on boolean-heavy models (Tekla 170_KM: 22.0s → 12.8s of serial geometry), byte-identical — the sign / boolean / retriangulation determinism manifests and full geometry suite are unchanged. Four profile- and literature-driven optimizations (Attene "Indirect Predicates" §5.4, Shewchuk):

  - **BVH boolean classification** — `boolean_vids` scanned the _entire_ opposite operand per arrangement triangle (an exact ray-cast + an exact coincident-face probe). A median-split AABB BVH (conservative ray + band-radius point queries) prunes each to O(log N + hits); the parity/any-match results are order-independent, so the verdict is unchanged.
  - **Memoize `to_f64_pt`** — classification and the output map materialize the same heavily-shared conforming vertices many times; each interned point's f64 value is now computed once per arrangement.
  - **Cache interval lambdas in the seg×seg pre-pass** — the O(n²) crossing loop re-derived each endpoint's degree-4/7 LPI/TPI interval lambda on every `orient2d`; compute it once and run the crossing test straight from it, falling to the exact cascade only on a straddle.
  - **Materialize f64 from the cached lambda** — reuse the interner's already-cached I512 lambda instead of re-deriving it at I1024.

  The remaining cost is the conforming retriangulation (constrained Delaunay) and the exact predicate arithmetic itself — the genuine exact-CSG floor. The win grows with operand size and applies to every boolean-heavy model.

- [#1163](https://github.com/LTplus-AG/ifc-lite/pull/1163) [`200681b`](https://github.com/LTplus-AG/ifc-lite/commit/200681ba17f162aaafaabf56c0723ddba693faf8) Thanks [@louistrue](https://github.com/louistrue)! - Add an analytic fast path for rectangular openings, skipping the exact CSG kernel
  for the common case.

  The pure-Rust exact CSG kernel is at its single-threaded, memory-bandwidth-bound
  floor (it won't parallelise — adding geometry workers gives no speedup), and
  void-cutting is ~85-90% of load. The only remaining lever is doing _less_ exact
  CSG. `rect_fast` cuts axis-aligned rectangular openings through an axis-aligned
  box host (the dominant case: windows/doors in a straight wall) with a 3D cellular
  decomposition instead of the mesh-arrangement kernel: split the host box by every
  opening plane on all three axes, mark each cell solid/void, and emit the exposed
  faces. Watertight by construction (shared snapped grid vertices on the kernel's
  own `SNAP_GRID`), deterministic (FMA-free f64 → byte-identical native==wasm), and
  handles windows, doors (flush to an edge), recesses, notches, and overlapping
  openings uniformly.

  It is a pure optimization: any case it can't prove safe — non-box host (multi-
  layer / chamfered / diagonal walls), non-rectangular opening, or a near-edge
  feature whose grid lines would collapse at the host's f32 magnitude — defers to
  the exact kernel unchanged. `IFC_LITE_RECT_FAST=0` forces everything back to the
  exact path.

  Measured (dental*clinic, a box-wall-dominated building): ~94% of openings cut
  analytically, void-cut geometry time ~0.95 s → ~0.32 s (~3×), with 2% \_fewer*
  triangles (no bloat). Models with more multi-layer or diagonal walls fire less
  (those correctly defer).

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0

## 2.7.2

### Patch Changes

- [#1131](https://github.com/LTplus-AG/ifc-lite/pull/1131) [`b7353ab`](https://github.com/LTplus-AG/ifc-lite/commit/b7353abe19a9414073d5d2526429d31e3c970af2) Thanks [@louistrue](https://github.com/louistrue)! - Content-affinity worker routing for boolean-heavy models. The streaming geometry
  pre-pass now tags each job with an affinity key — the exact 128-bit hash of the
  element's representation geometry — and the parallel dispatcher routes all jobs
  sharing a key to the same worker. Combined with the per-worker geometry-dedup
  cache, each unique geometry is meshed once **per model** instead of once per
  worker, so the workers partition the unique meshing instead of replicating it.
  Restores fast loads on models exported without `IfcMappedItem` (e.g.
  structural-steel detailers that emit thousands of byte-identical parts): a 19.5 MB
  steel model drops from ~32 s to ≈ the dedup floor split across the worker pool.
  Falls back to the previous interleaved split when no affinity data is present.
- Updated dependencies [[`b7353ab`](https://github.com/LTplus-AG/ifc-lite/commit/b7353abe19a9414073d5d2526429d31e3c970af2)]:
  - @ifc-lite/wasm@2.9.1

## 2.7.1

### Patch Changes

- [#1121](https://github.com/LTplus-AG/ifc-lite/pull/1121) [`33874e3`](https://github.com/LTplus-AG/ifc-lite/commit/33874e3088c67f6dfe26666852bd80d6ac1dea71) Thanks [@louistrue](https://github.com/louistrue)! - Stop boolean-heavy models still hanging at 95% after the per-boolean escalation budget ([#1109](https://github.com/LTplus-AG/ifc-lite/issues/1109) follow-up).

  The deterministic per-boolean budget ([#1112](https://github.com/LTplus-AG/ifc-lite/issues/1112)) bounded a _single_ boolean, but two holes kept dense models stalling past the geometry-stream watchdog:

  - **Overshoot.** The budget's `tripped()` check only fired at arrangement loop boundaries — once per triangle in the seam retriangulation. A single heavily-fragmented host face (a slab cut by 24-47 openings) inserts thousands of constraint points in _one_ `triangulate` call, so a boolean ran to **7.7M** escalations — ~4 minutes — between two checks before bailing. Profiled on a real model: one IFCSLAB took 243 s.
  - **Distributed cost.** An element with many openings runs one boolean _per_ opening, each well under the per-boolean cap, so none trips — yet the element's total exact work is huge and the geometry batch blows the stream watchdog.

  This adds a **per-element** escalation budget alongside the per-boolean one. `kernel::budget::begin_element()` (called once per element at the unified `produce_element_meshes` entry — native _and_ wasm) accumulates escalations across every boolean the element issues; when the element total crosses `DEFAULT_ELEMENT_CAP = 100_000` it degrades as a whole (remaining cuts bail to the [#635](https://github.com/LTplus-AG/ifc-lite/issues/635) AABB box-cut), instead of grinding. The kernel's per-point retriangulation and constraint-recovery loops now also check the budget, so a single boolean can no longer overshoot the cap by 15×.

  Still a **deterministic count**, accumulated in deterministic per-opening order on the element's single worker thread (the kernel has no internal rayon), so native and wasm degrade the _same_ element identically — the cross-target parity the kernel exists to guarantee is preserved. Calibrated against the model corpus: healthy per-element totals are p99 ≈ 13k escalations, so the 100k cap (~8× p99) never false-trips a legitimate cut. The cap engages only when an element scope is opened (the batch path); direct kernel/router callers, the server, and offline export stay unbounded via the existing `set_cap(None)` / `IFC_LITE_CSG_BUDGET=0` switch — so the pinned determinism manifests are unchanged.

  Measured on the profiling corpus (one boolean-heavy structural model): the worst element drops from 243 s to 2.9 s, and total serial geometry from minutes to ~28 s.

- [#1121](https://github.com/LTplus-AG/ifc-lite/pull/1121) [`33874e3`](https://github.com/LTplus-AG/ifc-lite/commit/33874e3088c67f6dfe26666852bd80d6ac1dea71) Thanks [@louistrue](https://github.com/louistrue)! - Speed up the exact CSG kernel's constraint-recovery hot path on dense-opening models ([#1109](https://github.com/LTplus-AG/ifc-lite/issues/1109)).

  Profiling the boolean-heavy slabs that hung the geometry stream showed the kernel spends ~80% of its time in constraint-recovery retriangulation — split between the channel-detection scan and the pocket earcut. Two parity-safe optimizations:

  - **Channel detection.** The per-segment O(tris) channel scan recomputed `orient(a,b,vertex)` for each triangle _edge_, but a triangle has only three vertices — so compute each vertex's side of the `(a,b)` line once and run the reciprocal edge-side test only for edges whose endpoints straddle it: ~3 exact predicates per triangle instead of up to 12. **Channel scan 9.6s → 2.9s (3.3×)** on the profiling corpus.
  - **Pocket earcut.** The ear-emptiness test ran an exact `strictly_outside` predicate for every other ring vertex. A conservative f64-AABB prefilter (the same widened-margin technique already used by `tri_aabb_disjoint`) skips the exact test for vertices provably outside the ear's AABB. This cuts the earcut's exact-predicate count on large pockets, which also lowers the per-element escalation count, so the [#1109](https://github.com/LTplus-AG/ifc-lite/issues/1109) budget cuts more openings exactly before degrading.

  Both produce **byte-identical** output — they compute the same exact predicate signs, and the prefilter only skips vertices it proves are outside — so the pinned determinism manifests, snapshots, and native==wasm parity are unchanged. End-to-end on a boolean-heavy structural model (per-element budget on): 23.6s → 19.4s of serial geometry; the channel-detection raw speedup is 3.3× (the budget converts the remaining headroom into more openings cut exactly rather than pure wall-time).

## 2.7.0

### Minor Changes

- [#1112](https://github.com/LTplus-AG/ifc-lite/pull/1112) [`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c) Thanks [@louistrue](https://github.com/louistrue)! - Fix the exact CSG kernel hanging at 95% on boolean-heavy models (issue [#1109](https://github.com/LTplus-AG/ifc-lite/issues/1109)), without sacrificing the cross-target determinism the kernel exists to guarantee.

  The pure-Rust exact kernel ([#1024](https://github.com/LTplus-AG/ifc-lite/issues/1024)) replaced Manifold + the legacy BSP port with one bit-deterministic kernel — the right call for server↔client parity (clients run a native Rust server _and_ the wasm viewer and need matching results). But the flip dropped Manifold's/BSP's operand cap, so a boolean-heavy model (Tekla half-space end-clips, Revit flush openings — full of near-coplanar faces) drives the exact predicate cascade off its interval filter on a huge fraction of predicates, climbing the fixed-width rungs (to ~1340 bits) and into BigRational with no safety valve. The geometry stream never finishes; the loader stalls at 95%.

  This adds a **deterministic** per-boolean budget: it counts interval-filter failures (every predicate that needs the expensive exact tier) and, when the count crosses a cap, bails the boolean to the un-cut host so the existing [#635](https://github.com/LTplus-AG/ifc-lite/issues/635) AABB box-cut fallback fires. The count is a pure function of the snap-grid operands, so the trip point is identical on native x86*64/aarch64 and wasm32 — the server and the browser degrade the \_same* hard element to the _same_ fallback. A wall-clock budget would have broken parity (fast native finishes the exact cut while slow wasm trips), so the metric is deliberately platform-independent.

  The cap (`budget::DEFAULT_CAP = 500_000`) is calibrated 33× above the worst healthy boolean measured across the model corpus (~15k exact evaluations), so it never false-trips a legitimate cut; healthy models are byte-identical (determinism manifests unchanged). `budget::set_cap(None)` (or `IFC_LITE_CSG_BUDGET=0`) lifts it for the server/offline-export profile where "exact but slow" is acceptable — one code path, two profiles, no kernel fork.

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

### Patch Changes

- [#1108](https://github.com/LTplus-AG/ifc-lite/pull/1108) [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec) Thanks [@louistrue](https://github.com/louistrue)! - Fix curved / opening-dense wall hairline cracks (a watertightness guard on consolidation)

  `ClippingProcessor::consolidate_coplanar` re-triangulates each coplanar plane
  bucket of the exact-kernel cut output INDEPENDENTLY. On a curved/faceted or
  opening-dense host, a FLAT bucket whose boundary runs along the faceted surface
  (an opening reveal, a cap, a curved-wall rim) gets its boundary chorded by the
  i_overlay union + collinear simplify — dropping the facet-boundary vertices the
  abutting buckets keep. The result was open boundary edges + T-junctions at the
  cut seam: thin white horizontal hairline cracks that shimmer under double-sided
  rendering. The raw kernel output is watertight; only the post-kernel
  consolidation introduced the gaps (a 24-facet curved host cut by one opening went
  from 0 open edges raw to 9 after consolidation).

  The fix is a watertightness guard at the end of `consolidate_coplanar`: if
  consolidation INTRODUCED open boundary edges and the raw kernel mesh is the
  cleaner one overall (by open edges + spike triangles), return the raw mesh. The
  overwhelming majority of hosts consolidate watertight (count 0) and return
  immediately — byte-identical, so the determinism snapshots and the
  `indirect_sign_manifest` constant are unchanged (the exact kernel is untouched).
  Only genuinely-torn hosts fall back to raw.

  Result on ISSUE_068 (opening-dense school): curved-wall open boundary edges
  4973 → 2323 (-53%), with the worst walls (the curved reception counter) now
  watertight. Also fixes a latent cavity crack on the [#780](https://github.com/LTplus-AG/ifc-lite/issues/780) bath and ~110 latent
  open edges on the FZK-Haus gable walls (their `csg_quality` bar is updated from
  spike-free to watertight, since the visible defect was the cracks). A future
  seam-preserving consolidation should deliver both watertight AND sliver-free for
  the residual "both-outputs-imperfect" hosts.

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Drop degenerate f32 triangles so large georeferenced models stop showing gross "fan" corruption.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (e.g. a model whose extent reaches ~220 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there. Vertices closer together than one ULP round to the same — or near-same — f32 value, so the triangles joining them collapse into zero-area slivers; when the third vertex is far away the result is a long, thin triangle that visibly fans across the whole model.

  `Mesh::drop_degenerate_triangles` now runs in `build_mesh_data` — the single funnel every element `MeshData` passes through on both the native and WASM pipelines — and removes only unambiguously-degenerate triangles: a bit-identical f32 vertex pair (exact zero area) or an aspect ratio above 1e5. These slivers carry no area, so neighbouring triangles of the same face already cover the surface and the removal is visually lossless. On a 54 MB georeferenced building model this drops all 664 catastrophic fans (0.29% of triangles) with no change to the remaining geometry, no kernel-determinism impact (predicate-sign manifests unchanged), and the synthetic-coordinate correctness harness stays byte-identical. The complete fix (local-frame / tiled vertex storage that keeps the vertices distinct) is tracked separately; this is the backstop that keeps the viewer clean meanwhile.

- [#1099](https://github.com/LTplus-AG/ifc-lite/pull/1099) [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM geometry stall on opening-dense walls (follow-up to [#1097](https://github.com/LTplus-AG/ifc-lite/issues/1097)).

  Walls carrying many openings (e.g. a curtain/window wall with 8-14 voids) stalled
  the streaming geometry load in WASM — one such element could block a worker for
  40-150 s, tripping the stream watchdog. Native processing of the same element was
  ~0.2 s; the gap is WASM's emulation of the exact kernel's wide-integer (i1024)
  predicates, amplified by two structural costs that this change removes:

  - **Opening-dense host refinement.** A window wall is usually two huge face
    triangles per side, so every void's intersection segments pile onto those few
    triangles. The exact arrangement then re-triangulates a single triangle carrying
    dozens of constraint segments (O(k²)), and — worse — the batched N-ary subtract
    leaves unrecovered constraints and degrades to the O(N²) sequential path
    (re-arranging the growing host once per opening). When a host has ≥ 8 openings we
    now pre-subdivide it (1-2 levels of uniform midpoint subdivision) so each
    triangle carries only a few segments and the batched cut recovers. `consolidate_
coplanar` re-triangulates each coplanar group afterwards, so the temporary
    interior vertices don't survive except where a hole boundary pins them.
  - **Conservative broadphase prefilters in the exact re-triangulation.** The three
    O(N²) exact-predicate scans (`insert_point` point-location, `enforce_constraint`'s
    collinear-vertex scan, `recover_subsegment`'s channel scan) now skip the exact
    test for vertices/triangles outside a generously-widened f64 AABB, and all-explicit
    `orient2d` triples use the fast adaptive Shewchuk predicate instead of the
    WASM-emulated i1024 lambda path. The margin dwarfs any f64/implicit-point error,
    so the exact predicate still decides every retained case — output is byte-identical
    on every platform.

  Net: the worst dense wall drops from ~150 s to ~30 s in WASM (10× on most), the
  model loads without stalling, and native cold-load is ~20 % faster overall. The
  refinement is gated to ≥ 8-opening hosts (absent from the snapshot fixtures), so
  the determinism corpus and committed snapshots are unchanged; the prefilters and
  Shewchuk path are byte-identical everywhere. Geometry suite 439/439 green.

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Drop sub-grid sliver triangles so faceted geometry stops rendering spikes

  After the pure-Rust CSG kernel replaced Manifold ([#1024](https://github.com/LTplus-AG/ifc-lite/issues/1024)), the pipeline no longer
  cleaned the degenerate output Manifold used to remove on import. Faceted breps,
  extrusion-profile walls and walls with openings could therefore render visible
  needle "spikes" and jagged silhouettes coming from zero-area / collinear sliver
  triangles (other viewers don't show them because they clean degenerates on import).

  `Mesh::clean_degenerate` now drops triangles whose perpendicular height is below the
  kernel's reconcile grid (1/65536 m ≈ 15.3 µm) — sub-resolution coincident-pair and
  collinear slivers that carry no area. It runs at every mesh-output chokepoint
  (per element, per sub-mesh, and on the void-cut output), so both wasm (viewer) and
  native (server) get identical output. Vertices and normals are left untouched, so
  flat shading / sharp creases are preserved and the result is bit-deterministic. On a
  large faceted-brep building this removes 100% of the genuine degenerate slivers for a
  ~1% triangle reduction with no performance cost.

- [#1099](https://github.com/LTplus-AG/ifc-lite/pull/1099) [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8) Thanks [@louistrue](https://github.com/louistrue)! - Geometry load-cost reductions for large models (follow-up to [#1097](https://github.com/LTplus-AG/ifc-lite/issues/1097) profiling).

  Profiling the streaming geometry pipeline on large models (Holter 169 MB / 109 k meshes, bouwkundig 327 MB / 55 k meshes) showed the load is bound by per-element decode + mesh production, NOT by CSG (measured ~2 k / ~246 boolean ops — negligible), distribution, or tessellation. The following reduce redundant per-batch work without changing geometry output (wasm-contract 19/19, mesh counts identical):

  - **Cache the geometry-style maps per worker.** The style→RGBA map and the derived `GeometryStyleInfo` index were rebuilt from the session-constant wire arrays on every `processGeometryBatch` call (~18 M HashMap inserts each on a 140 k-styled model). They're now built once per worker, keyed by a cheap signature — a measured ~5 % wall-clock win.
  - **Fold the element-colour resolution into the main producer loop** instead of a separate pre-pass that re-decoded every job entity, and decode each entity once via the cached `Arc<DecodedEntity>` (no deep clone). Eliminates a full duplicate decode pass per batch.
  - **`MeshCollection.takeMesh`**: move the mesh out of the collection on the streaming read path instead of cloning all vertex buffers, then copying again to JS — one fewer full copy of positions/normals/indices per mesh.
  - **Load-time visibility filter** (`ProcessParallelOptions.visibilityFilter` / `globalThis.__IFC_LITE_VISIBILITY_FILTER`): skip geometry jobs for disabled types (spaces, annotations, type-library) at prepass generation so they're never decoded/meshed/uploaded. Toggling a type back on requires a reload.

- [#1099](https://github.com/LTplus-AG/ifc-lite/pull/1099) [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8) Thanks [@louistrue](https://github.com/louistrue)! - Fix the geometry stream watchdog killing healthy loads on CSG-dense models (issue [#1097](https://github.com/LTplus-AG/ifc-lite/issues/1097)). The mid-stream stall deadline scaled with file size (MB), but the real silent window is the wall-time of one synchronous `processGeometryBatch` call, which tracks CSG density per job — uncorrelated with megabytes. A ~275 MB dense steel model (190k+ meshes) tripped its own `15s + MB*30 = 23s` deadline mid-stream.

  - The worker now sizes each `processGeometryBatch` call adaptively to a wall-time budget (`batch-sizing.ts`, default 8 s) instead of a fixed 512-job count, so the silent window stays bounded regardless of CSG density and heartbeats flow continuously. Tuned on the largest real models — measured **40% faster on a 986 MB / 14 M-entity / 231 k-mesh model (100.9 s → 72.5 s)** vs. an over-conservative small-batch cut, and at or faster than the previous fixed-batch behaviour on mid-size models. An optional `batchSizing` override (`ProcessParallelOptions.batchSizing` or the `globalThis.__IFC_LITE_BATCH_SIZING` hook) allows hardware-specific tuning.
  - The subsequent-batch watchdog deadline is now a fixed grace (40 s browser / 25 s desktop), decoupled from file size; the first-batch deadline still scales with size for the single-threaded pre-pass.
  - The binary-split recovery path emits a liveness heartbeat before recursing/re-initialising, and a recovery WASM re-init now replays the pre-built entity index instead of falling back to an O(file) re-scan, closing the secondary silent window.

- [#1106](https://github.com/LTplus-AG/ifc-lite/pull/1106) [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb) Thanks [@louistrue](https://github.com/louistrue)! - Faster exact CSG kernel (stage 2a): f64 interval tier for `cmp_along` (tri-tri ordering).

  Closes the last plan-flagged float-filter hole on top of the interval-lambda filter: the 1-D ordering of tri-tri crossing points (`cmp_along`) went straight to the I512 tier then BigRational with no interval pre-filter. `interval::cmp_along` (a pure-f64 directed-rounding mirror of `fixed::cmp_along`) now runs first; `tritri.rs` falls to I512/BigRational only on a zero-straddle. Because the interval is outward-rounded (no FMA), a definite sign equals the exact sign and is bit-identical native==wasm==x86_64==aarch64 — manifest constant and snapshots unchanged. Cumulative with the interval-lambda filter: native geometry ~4.2s → ~2.8s.

- [#1105](https://github.com/LTplus-AG/ifc-lite/pull/1105) [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9) Thanks [@louistrue](https://github.com/louistrue)! - Faster exact CSG kernel: cached f64 interval-lambda predicate filter (one canonical kernel).

  Stage 1 of migrating the exact predicate cascade off WASM-emulated wide-integer
  (I512) arithmetic toward the modern "spend the budget in the float filter" design
  (Cherchi/Attene). The exact kernel's hot re-triangulation predicates resolved via
  the cached I512 lambda determinant, which WASM emulates ~hundreds× slower than
  native's hardware path — on opening-dense models that bignum dominated worker CPU.

  The interner now caches a directed-rounding **f64 interval lambda** per point
  (alongside the existing I512 lambda). `orient2d_v`, `cmp_lex_v`, and the interner's
  dedup compare run a pure-f64 interval determinant from it FIRST, falling to the
  exact I512/BigRational tiers only on a genuine zero-straddle. Because the interval
  is outward-rounded (no FMA), a definite sign equals the exact sign and is
  bit-identical across native/wasm/x86_64/aarch64 — the `indirect_sign_manifest`
  constant and the geometry-correctness snapshots are unchanged (determinism
  preserved, no drift, no parallel path).

  Result on ISSUE_068 (opening-dense facade): native geometry 4.2s → 2.9s (−30%,
  benefits the server too), WASM load 46s → 41s. Byte-identical mesh output; full
  geometry suite green (53/53 binaries, manifest + snapshots unchanged). Follow-ups
  extend the same filter to the remaining bignum sites and add a float-expansion
  exact tier for the degenerate tail.

- Updated dependencies [[`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/wasm@2.8.1

## 2.6.1

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Client/server alignment fixes:

  - `@ifc-lite/create`: `IfcCreator` now generates spec-valid 128-bit GlobalIds via the canonical `@ifc-lite/encoding` encoder (previously ~94% of generated ids failed `isValidIfcGuid` and silently changed identity on guid→uuid→guid round-trips, e.g. in BCF).
  - `@ifc-lite/export`: schema-downgrade `IFCPROXY` placeholders now carry spec-valid GlobalIds instead of synthetic `PROXY_…` markers.
  - `@ifc-lite/parser`: `extractLengthUnitScale` now mirrors the canonical Rust extractor when an `IfcMeasureWithUnit` ValueComponent is unreadable — defaults the value to 1.0 and still applies the UnitComponent SI-prefix instead of falling through to metres (property scaling can no longer desync from geometry scaling).
  - `@ifc-lite/geometry`: removed the dead legacy worker protocol (`process`/`prepass`/`prepass-fast` messages) — the streaming protocol (`stream-start`/`stream-chunk`/`stream-end` + `prepass-streaming`) is the only path; the wasm `buildPrePassFast` export is gone. Streaming pre-pass loads now apply aggregate void propagation (window/door cuts on aggregated parts) in parity with one-shot loads and the server.
  - `@ifc-lite/server-client`: `ProcessingStats` gains optional `total_csg_failures` / `products_with_failures` fields — the server now reports the same CSG failure diagnostics the browser console shows.

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Client surface alignment (audit follow-ups):

  - `@ifc-lite/server-client`: `ServerConfig.token` sends `Authorization: Bearer` on every request (servers running `IFC_SERVER_API_TOKEN` were unreachable from the TS client); the `ParseResponse` / `ProcessingStats` / `MeshData` mirrors gain the optional fields the Rust server actually serves (`mesh_coordinate_space`, transforms, scan/lookup/preprocess timings, mesh metadata).
  - `@ifc-lite/geometry`: the worker-pool converter now carries `shadingColor` across the worker boundary — GLB "Shading" export no longer degrades on the default (parallel) load path; dead legacy wasm bindings removed (`IfcAPI.parse`, `parseStreaming`, `scanRelevantEntitiesFastBytes`, `MeshCollection.localToWorld`).
  - `@ifc-lite/export`: `assembleStepBytes` deduplicated into `step-serialization` (was copied byte-for-byte in the STEP and merged exporters).

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe)]:
  - @ifc-lite/data@2.0.3

## 2.6.0

### Minor Changes

- [#1024](https://github.com/LTplus-AG/ifc-lite/pull/1024) [`cdc5a78`](https://github.com/LTplus-AG/ifc-lite/commit/cdc5a78af4e6019981f0189ae14b6201d1bdf8a4) Thanks [@louistrue](https://github.com/louistrue)! - One CSG kernel: pure-Rust exact mesh arrangement. The Manifold C++ kernel
  (viewer/WASM) and the legacy in-tree BSP port (server/native) are replaced by a
  single clean-room exact-arithmetic kernel (Cherchi-style indirect predicates)
  that runs identically on native and wasm32 — bit-deterministic across x86_64,
  aarch64 and the browser, with no C++ toolchain in the build.

  No API changes — `processGeometryBatch` and the SDK surface are unchanged.
  Consumers see different (better) triangulations wherever booleans fire:
  openings, clippings and flush recesses now cut watertight through exactly
  coincident/coplanar faces instead of relying on perturbation epsilons, tilted
  flush cuts no longer leave boundary cracks or seam slivers, and deep
  clipping-chain cutters are unioned and subtracted in one arrangement. Geometry
  fingerprints (`geomHash`) for boolean-cut elements change accordingly; the
  compare-models flow is unaffected because both revisions hash in-session with
  the same kernel.

### Patch Changes

- Updated dependencies [[`cdc5a78`](https://github.com/LTplus-AG/ifc-lite/commit/cdc5a78af4e6019981f0189ae14b6201d1bdf8a4)]:
  - @ifc-lite/wasm@2.7.0

## 2.5.1

### Patch Changes

- [#1005](https://github.com/LTplus-AG/ifc-lite/pull/1005) [`9c3042a`](https://github.com/LTplus-AG/ifc-lite/commit/9c3042ad1004877cb6f03349b803a207c3b14ae1) Thanks [@Blogbotana](https://github.com/Blogbotana)! - fix(geometry): cut tilted/profile-section openings with the real mesh ([#977](https://github.com/LTplus-AG/ifc-lite/issues/977))

  Openings on tilted steel members (Tekla channels, tubes, I-beams, gusset plates)
  were cut by the analytic axis-aligned-box clip. The AABB of a tilted thin cutter
  is far larger than the authored cutter, so it over-cut — removing real section
  material and leaving a thin residual wall — and the analytic path also fabricates
  reveal/cap walls in the open profile. This was a project-wide error on every
  tilted member.

  Openings are now routed by a **type-independent geometric test**: when an
  opening's world AABB volume significantly exceeds its actual cutter-solid volume
  (i.e. the cutter is tilted or non-box), it is cut with its **real mesh** via the
  Manifold boolean — exact authored shape, no bounding-box inflation, and the
  kernel's perturbation clears coplanarity with the profile's inner faces/fillets.
  Axis-aligned box openings (AABB ≈ cutter) keep the cheap, deterministic analytic
  clip, so flat slab/wall openings stay stable on CI. Because the test is geometry-
  not type-based, it works regardless of how an exporter labels elements (incl.
  projects that model everything as IfcBuildingElementProxy).

  Also retunes the Manifold cutter perturbation to clear the kernel's host-relative
  coplanarity tolerance.

- Updated dependencies [[`9c3042a`](https://github.com/LTplus-AG/ifc-lite/commit/9c3042ad1004877cb6f03349b803a207c3b14ae1)]:
  - @ifc-lite/wasm@2.6.1

## 2.5.0

### Minor Changes

- [#1025](https://github.com/LTplus-AG/ifc-lite/pull/1025) [`c003017`](https://github.com/LTplus-AG/ifc-lite/commit/c0030175e82f194183b60492c1de34eca6b5d691) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Expose the consumer-configurable tessellation quality ([#976](https://github.com/LTplus-AG/ifc-lite/issues/976)) on the SDK/WASM surface. `IfcAPI.setTessellationQuality('lowest' | 'low' | 'medium' | 'high' | 'highest')` selects the detail level applied by every subsequent `processGeometryBatch` call, and `@ifc-lite/geometry`'s `GeometryProcessor` accepts a `tessellationQuality` constructor option plus a `setTessellationQuality()` runtime setter that forward the level to the main-thread, streaming and worker-pool WASM paths. Unset / `'medium'` reproduces the engine's historical densities byte-for-byte, so existing consumers see no change; lower levels coarsen curved geometry for throughput, higher levels reduce faceting on pipes / cylinders / NURBS at a proportional triangle-count cost.

### Patch Changes

- Updated dependencies [[`c003017`](https://github.com/LTplus-AG/ifc-lite/commit/c0030175e82f194183b60492c1de34eca6b5d691)]:
  - @ifc-lite/wasm@2.6.0

## 2.4.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/wasm@2.5.1

## 2.4.0

### Minor Changes

- [#998](https://github.com/LTplus-AG/ifc-lite/pull/998) [`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f) Thanks [@louistrue](https://github.com/louistrue)! - Add a 3D **Model / Types** view switch (turns the [#957](https://github.com/LTplus-AG/ifc-lite/issues/957) type geometry into a feature).

  The viewer mesh path (`processGeometryBatch`) now always emits an `IfcTypeProduct`'s `RepresentationMap` geometry, tagging each mesh with a `geometryClass`: `0` = occurrence, `1` = orphan type (no occurrence — buildingSMART annex-E showcase files), `2` = instanced type-library shape (a type linked to an occurrence via `IfcRelDefinesByType`). `MeshDataJs.geometryClass` (wasm) and `MeshData.geometryClass` (`@ifc-lite/geometry`) carry it across the boundary.

  The viewer's Visibility menu gains a Model/Types segmented control. **Model** (default) shows occurrences + orphan types and hides class‑2 type-library shapes — so the AC20/ArchiCAD "duplicate boxes at the wrong position" never appear. **Types** shows the type library (classes 1 + 2 at their map origins) and hides occurrences. The switch re-filters the cached mesh set instantly (no reload) and the choice persists across reloads.

  The native `process_geometry` path is unchanged — it still suppresses instanced-type geometry so server/CLI/SDK exports never duplicate it.

### Patch Changes

- Updated dependencies [[`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e), [`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f), [`35413b9`](https://github.com/LTplus-AG/ifc-lite/commit/35413b9efd0178cff6022f2b1092ac532868d6cd)]:
  - @ifc-lite/wasm@2.4.0

## 2.3.0

### Minor Changes

- [#987](https://github.com/LTplus-AG/ifc-lite/pull/987) [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c) Thanks [@louistrue](https://github.com/louistrue)! - Model comparison in the viewer ([#924](https://github.com/LTplus-AG/ifc-lite/issues/924)). A new **Compare** panel (Analysis menu)
  lets you pick two loaded models as version A/B, run a comparison, and review
  **added / changed / deleted** elements — colour-coded in 3D (green / yellow /
  red, with unchanged ghosted or hidden) and listed in the panel; clicking a row
  selects and frames the element. A **data / geometry / both** scope toggle
  switches what counts as a change.

  `@ifc-lite/geometry` now surfaces the WASM mesh pass's RTC-invariant per-entity
  geometry fingerprint: `GeometryProcessor.enableGeometryHashes()` turns it on and
  each `MeshData.geometryHash` carries the hash (threaded through the streaming +
  parallel worker paths). This feeds the geometry side of the diff: a moved or
  reshaped element reads as a geometry change, while the global georeferencing
  offset (RTC) does not — the hash is RTC-invariant.

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

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/data@2.0.1
  - @ifc-lite/wasm@2.3.0

## 2.2.0

### Minor Changes

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

- [#966](https://github.com/LTplus-AG/ifc-lite/pull/966) [`773b508`](https://github.com/LTplus-AG/ifc-lite/commit/773b5086456de3c61bdde8a72dd3d35325e2e995) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(grids): expose structural grids (IfcGrid/IfcGridAxis) in the render frame ([#945](https://github.com/LTplus-AG/ifc-lite/issues/945))

  Resolve `IfcGridAxis` curves through the same placement + unit-scale + RTC
  pipeline the meshes use and emit them in the renderer's Y-up, RTC-subtracted,
  metres world frame, so structural grids overlay streamed geometry by
  construction (no viewer re-implements the placement resolver).

  - New WASM API `parseGridLines(content) -> Float32Array` (flat 3D line-list)
    and `parseGridAxes(content) -> GridAxisCollection` (structured per-axis
    `{ gridId, axisId, tag, start, end }`), mirroring `parseAlignmentLines`.
  - New `@ifc-lite/geometry` `GeometryProcessor.parseGridLines` /
    `parseGridAxes` (returns plain `GridAxis[]`) and a `GridAxis` type.
  - `CoordinateInfo` now also reports `lengthUnitScale` and populates
    `wasmRtcOffset` (the actually-applied RTC offset) directly from the geometry
    pipeline, so any consumer can map externally-resolved geometry into the
    render frame without viewer-side patching.

### Patch Changes

- [#973](https://github.com/LTplus-AG/ifc-lite/pull/973) [`f99666a`](https://github.com/LTplus-AG/ifc-lite/commit/f99666ae028a88f1378422dd20900929f026cd2b) Thanks [@louistrue](https://github.com/louistrue)! - fix(geometry): union segmented-roof clip cutters to stop wall slivers and dropped walls ([#960](https://github.com/LTplus-AG/ifc-lite/issues/960))

  Gable walls trimmed by a segmented roof are authored as deep left-deep
  `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
  chains (one cutter per roof plane). Two defects on House.ifc:

  - Walls clipped by 12+ roof planes blew the boolean recursion-depth limit and
    rendered as nothing.
  - Sequentially subtracting abutting roof-segment prisms left a zero-thickness,
    full-height fin on the shared seam — a thin wall sliver poking through the
    roof.

  The chain is now walked iteratively and the cutter prisms are combined with a
  true CSG union before a single subtract, so the seam face is dissolved and the
  depth limit no longer bites. Two guards keep the well-tested per-cutter path
  for full-cross-section clips (duplex.ifc "Party Wall") and reject any union the
  kernel silently under-removes. Output is mm-identical to IfcOpenShell on all
  five reported walls.

- Updated dependencies [[`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`f99666a`](https://github.com/LTplus-AG/ifc-lite/commit/f99666ae028a88f1378422dd20900929f026cd2b), [`773b508`](https://github.com/LTplus-AG/ifc-lite/commit/773b5086456de3c61bdde8a72dd3d35325e2e995)]:
  - @ifc-lite/wasm@2.2.0

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
