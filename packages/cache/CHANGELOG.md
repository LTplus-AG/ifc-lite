# @ifc-lite/cache

## 2.2.0

### Minor Changes

- [#1706](https://github.com/LTplus-AG/ifc-lite/pull/1706) [`5b278f0`](https://github.com/LTplus-AG/ifc-lite/commit/5b278f0f8b2f2b42a723e9ef64341639670e291e) Thanks [@louistrue](https://github.com/louistrue)! - FORMAT_VERSION 13: chunked geometry section (issue [#1682](https://github.com/LTplus-AG/ifc-lite/issues/1682), phase 4 of the chunked-residency plan).

  Geometry is now written as spatially coherent, byte-capped chunk records behind a directory (AABB + offsets + counts per chunk), each independently decodable and deflate-raw compressed via the native CompressionStream (2-3x smaller entries). New incremental API: `openGeometryChunksV13` / `readGeometryHeadV13` / `decodeGeometryChunk` for streamed cache-hit loads; `BinaryCacheReader.read()` keeps its shape (full decode). Per-mesh record layout is unchanged; the version bump rolls cache keys so old entries re-mesh.

  BREAKING for pre-v13 files: the legacy sequential geometry reader/writer were removed - `read()` throws on pre-v13 geometry (the viewer's version-suffixed cache keys never hit such entries; the throw self-heals as discard-and-rebuild). The never-implemented `CacheWriteOptions.compress` placeholder was removed in favour of `compressGeometryChunks`.

## 2.1.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/geometry@3.1.4

## 2.1.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1

## 2.1.0

### Minor Changes

- [#1621](https://github.com/LTplus-AG/ifc-lite/pull/1621) [`8fdd200`](https://github.com/LTplus-AG/ifc-lite/commit/8fdd200c640034d74f5718741892577a00d737be) Thanks [@louistrue](https://github.com/louistrue)! - Add `CacheWriteOptions.omitSourceHash`. When set, `BinaryCacheWriter.write` skips the full-file `xxhash64(sourceBuffer)`, stores `sourceHash = 0n`, and sets the new `HeaderFlags.SourceHashUnset` — for callers that validate the source another way and don't want a large source to pay a full-file main-thread hash on write. `CacheHeaderInfo` gains `hasSourceHash`; `reader.read({ sourceBuffer })` skips header validation for such entries (instead of fail-closing), and `reader.validate()` throws a clear error rather than returning a misleading `false`. Default behaviour (the writer hashes the whole source) is unchanged, and entries written before this flag existed still validate normally.

## 2.0.11

### Patch Changes

- [#1562](https://github.com/LTplus-AG/ifc-lite/pull/1562) [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db) Thanks [@louistrue](https://github.com/louistrue)! - Bump the geometry cache `FORMAT_VERSION` 11 -> 12 for the source vertex weld. Element meshes are now welded at the source and the per-export welds were removed, so a v11 cache holds pre-weld (per-face-duplicated) geometry; restoring it and exporting would emit an unwelded, 3-6x larger GLB (regressing the export-weld win for cached-model users) and hand non-watertight raw MeshData to render/GLB consumers. The bump invalidates pre-weld caches so they re-mesh (welded) instead of restoring stale geometry.

- Updated dependencies [[`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/geometry@3.1.0

## 2.0.10

### Patch Changes

- [#1503](https://github.com/LTplus-AG/ifc-lite/pull/1503) [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229) Thanks [@louistrue](https://github.com/louistrue)! - fix(query): scope `whereProperty` to the named property set

  `EntityQuery.whereProperty(psetName, propName, ...)` recorded the property-set
  name but never passed it to `findByProperty`, so a property matched in _any_
  property set — e.g. filtering `Pset_WallCommon.IsExternal` also returned doors
  whose `Pset_DoorCommon.IsExternal` matched. `findByProperty` gains an optional
  `psetName` argument (honored by the in-memory, cache-restored, and
  server-converted property tables), and `whereProperty` now passes it. An unknown
  pset name matches nothing.

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0

## 2.0.9

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

- ea5e9bc: GLB importer: honor node matrices so instanced exports round-trip.

  The GLB importer (`parseGLBToMeshData`) composed only `node.translation` down the
  hierarchy, never `node.matrix`. The from-meshes export (the viewer's "Export GLB")
  emits translations only and round-tripped fine, but the from-bytes instanced exporter
  (#1443) places each shared-template occurrence with a node MATRIX (rotation +
  translation). Re-importing such a GLB collapsed every instanced occurrence onto the
  template (each matrix node contributed a zero translation), losing per-occurrence
  position and rotation.

  The importer now composes the full column-major 4x4 down the hierarchy. The composed
  TRANSLATION rides each mesh as `MeshData.origin` (kept out of the f32 vertex buffer for
  georeferenced precision, as before), and any ROTATION/SCALE is baked into the small,
  local imported vertices and normals (which stay f32-precise because they are
  template-local). The pure-translation path is byte-identical to before, so the viewer's
  own exports are unaffected.

  Verified end to end: a real instanced GLB exported by `ifc-lite-export` (C20-Institute)
  re-imports with occurrences spread across the building at many distinct world poses (not
  collapsed), with local vertices staying sub-metre. Normal note: rotation is exact; a
  non-uniform-scale instance would want the inverse-transpose for normals (a rare,
  accepted approximation, since instance transforms are rigid).

- fa36858: Fix GLB re-import: SharedArrayBuffer crash + georeferenced precision corruption.

  Two independent round-trip bugs in the GLB importer (`parseGLB` / `parseGLBToMeshData`):

  1. **SharedArrayBuffer decode crash.** The viewer streams large imports (>= 256 MB)
     into a `SharedArrayBuffer` (`acquireFileBuffer`), and that buffer reaches the GLB
     parser unchanged. `parseGLB` decoded the JSON chunk with `new TextDecoder().decode(view)`,
     which browsers reject for any SharedArrayBuffer-backed view (a Spectre mitigation) with
     "TextDecoder.decode: ... can't be a SharedArrayBuffer ...". Re-importing a large exported
     GLB therefore threw before any geometry was read. The JSON chunk now goes through
     `safeUtf8Decode` (already in `@ifc-lite/data`), which copies it into a private non-shared
     buffer on the SAB path. Only the small JSON chunk is copied; the binary chunk stays
     zero-copy (it was already copied via `.slice()`).

  2. **Georeferenced f32 re-snap.** The exporter keeps vertices relative to the model
     scene-centre and carries the placement on a single root-node translation, precisely so a
     georeferenced offset (a root translation of ~1e6 m) stays out of the f32 vertex buffer. The
     importer was baking that translation back into the f32 vertices, which re-snaps every vertex
     to a ~0.06-0.5 m grid at georef scale and collapses fine (rebar-scale) detail. It now surfaces
     the composed root translation as `MeshData.origin` (world = origin + position) instead, which
     the renderer and every world-space consumer already fold (the local-frame path). The
     non-georeferenced case (zero translation) is unchanged.

  Note: the importer's node walk still reads only `node.translation`, not `node.matrix`. The
  viewer's own "Export GLB" (from-meshes) emits only translations, so it round-trips fully. The
  from-bytes instanced exporter emits per-occurrence node matrices; round-tripping those is a
  follow-up that lands with the instancing work.

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

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0

## 2.0.8

### Patch Changes

- [#1238](https://github.com/LTplus-AG/ifc-lite/pull/1238) [`e753e96`](https://github.com/LTplus-AG/ifc-lite/commit/e753e96f9b76cc406e52a7bd9c36b312dc14bf6b) Thanks [@louistrue](https://github.com/louistrue)! - Persist GPU-instancing shards in the binary cache (new `InstancedShards` section,
  `GeometryData.instancedShards` / `CacheReadResult.geometry.instancedShards`). Opaque
  repeated occurrences are partitioned off the flat geometry into IFNS shards rendered
  from compact templates; without persisting them, reopening a cached model restored
  the flat meshes only and silently dropped all instanced geometry. The shard bytes
  are a self-contained wire format, so they're stored as a length-prefixed blob array
  (no re-encode) and restored through the renderer's normal decode/upload path.
  `FORMAT_VERSION` is bumped 9 → 10 so stale shard-less caches invalidate and re-mesh.

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

## 2.0.7

### Patch Changes

- [#1253](https://github.com/LTplus-AG/ifc-lite/pull/1253) [`cd6f6a5`](https://github.com/LTplus-AG/ifc-lite/commit/cd6f6a524050000990b78c5e420958d1872813e4) Thanks [@louistrue](https://github.com/louistrue)! - GLB export/import placement fixes.

  The GLB importer (`parseGLBToMeshData` / `loadGLBToMeshData`) now composes node-
  hierarchy translation into world vertex positions. The Rust exporter places all
  element geometry under a single translated root node (vertices stored relative to
  one scene centre for f32 precision); a parser that read accessors alone landed the
  whole model at that centre ("all centre aligned"). It now walks the scene roots,
  accumulates translation, and bakes it into each mesh node's vertices so re-imported
  GLBs — and any GLB with node transforms — land at their true world position.

  Paired with the Rust `ifc-lite-export` GLB/OBJ fixes (self-contained, scene-centre-
  baked geometry + IFC Z-up→WebGL Y-up conversion on the from-bytes path + double-
  sided materials).

## 2.0.6

### Patch Changes

- [#1234](https://github.com/LTplus-AG/ifc-lite/pull/1234) [`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb) Thanks [@louistrue](https://github.com/louistrue)! - Add entity retype (reassign class) to the mutation overlay.

  `EntityTable` gains an additive `setTypeOverride(expressId, typeName | null)` so
  a host (the viewer) can reflect a pending retype live in `getTypeName` /
  `getTypeEnum` without rebuilding the table; the original columnar type is left
  intact.

  `StoreEditor.setEntityType(expressId, newType, { predefinedType? })` and
  `MutablePropertyView.setEntityType(...)` change an entity's IFC class in place,
  and a new `BulkAction { type: 'SET_ENTITY_TYPE', entityType, predefinedType? }`
  applies it to a selection. `StepExporter` materializes the retype on export.

  The entity keeps its expressId, so geometry, placement, representation and every
  `IfcRel*` reference (all keyed by `#id`) carry over unchanged. Attributes are
  re-laid-out by name against the target class's declared layout — dropping
  attributes the target lacks (e.g. IFC2X3 `CompositionType`) and validating
  `PredefinedType` against the target enum (an unknown override falls back to
  `USERDEFINED` + `ObjectType`). This mirrors IfcOpenShell's
  `ifcopenshell.util.schema.reassign_class`. Intended for compatible
  reassignments such as the building-element subtypes that share the IfcElement
  layout (`IfcBuildingElementProxy` ↔ `IfcColumn`/`IfcBeam`/`IfcMember`/
  `IfcPlate`/`IfcWall`).

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb), [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384)]:
  - @ifc-lite/data@2.2.0
  - @ifc-lite/geometry@2.8.0

## 2.0.5

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

## 2.0.4

### Patch Changes

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`69e5425`](https://github.com/LTplus-AG/ifc-lite/commit/69e5425e3d7586fcc2d44a33465806adc0ed53f8), [`bd585c7`](https://github.com/LTplus-AG/ifc-lite/commit/bd585c73de1f39db3c9aac168174012b98b79855), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`200681b`](https://github.com/LTplus-AG/ifc-lite/commit/200681ba17f162aaafaabf56c0723ddba693faf8), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0
  - @ifc-lite/geometry@2.7.3

## 2.0.3

### Patch Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0

## 2.0.2

### Patch Changes

- [#1091](https://github.com/LTplus-AG/ifc-lite/pull/1091) [`7c7025a`](https://github.com/LTplus-AG/ifc-lite/commit/7c7025aa969c0606f6480ed4d2eeb9ec7c1b5e14) Thanks [@louistrue](https://github.com/louistrue)! - Persist `geometryClass` in the binary geometry section so the viewer's Model/Types view switch survives a cache hit. The format previously serialized everything except the per-mesh provenance tag, so restored meshes all came back as class 0 — instanced type-library geometry reappeared in Model mode and the Model/Types switch disappeared. Bumps `FORMAT_VERSION` 4 → 5 (older caches read back as class 0; consumers should key their cache entries on `FORMAT_VERSION` so a bump invalidates stale entries and re-meshes fresh).

## 2.0.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/geometry@2.4.1

## 2.0.0

### Major Changes

- [#993](https://github.com/LTplus-AG/ifc-lite/pull/993) [`ea7c132`](https://github.com/LTplus-AG/ifc-lite/commit/ea7c1324e77b5fde4b7d0775a013f2fdf90b26d2) Thanks [@louistrue](https://github.com/louistrue)! - Rename the serialized data-store type `IfcDataStore` → `CacheDataStore`.

  This removes the name collision with `@ifc-lite/parser`'s runtime `IfcDataStore` — the two are structurally different (the cache type is the on-disk/serialized shape, keyed on a numeric `schema` enum, with no `source`/`parseTime`/accessors). Consumers importing the type from `@ifc-lite/cache` must switch `IfcDataStore` → `CacheDataStore`.

### Patch Changes

- Updated dependencies [[`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f)]:
  - @ifc-lite/geometry@2.4.0

## 1.14.9

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

- Updated dependencies [[`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/data@2.0.1

## 1.14.8

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/data@2.0.0

## 1.14.7

### Patch Changes

- [#813](https://github.com/LTplus-AG/ifc-lite/pull/813) [`78f1d10`](https://github.com/LTplus-AG/ifc-lite/commit/78f1d10aab812da682962845638daa95b86ae178) Thanks [@louistrue](https://github.com/louistrue)! - fix(glb): preserve per-mesh colours when re-importing a `.glb`

  Both GLB importers (`parseGLBToMeshData` in `@ifc-lite/cache` and the
  secondary one in `@ifc-lite/export`) hardcoded
  `color: [0.8, 0.8, 0.8, 1.0]` on every mesh and never looked at
  `materials[*].pbrMetallicRoughness.baseColorFactor`. After the
  GLB-export-dialog work ([#688](https://github.com/LTplus-AG/ifc-lite/issues/688)) wired colour authoring through the
  exporter end-to-end, a round-trip
  (IFC → GLB → re-import as model) silently lost all colour and the
  viewport went grey.

  Fix: resolve each primitive's `material` index against the glTF
  `materials` array and copy `baseColorFactor` into `MeshData.color`,
  keeping the previous grey as the fallback when a primitive has no
  material (e.g. third-party glTFs). Regression tests added in both
  packages cover the round-trip and the no-material fallback.

## 1.14.6

### Patch Changes

- [#810](https://github.com/LTplus-AG/ifc-lite/pull/810) [`e80e728`](https://github.com/LTplus-AG/ifc-lite/commit/e80e7281273a4a8352d9efae151f07c9f6be18f7) Thanks [@louistrue](https://github.com/louistrue)! - fix(glb): preserve per-mesh colours when re-importing a `.glb`

  Both GLB importers (`parseGLBToMeshData` in `@ifc-lite/cache` and the
  secondary one in `@ifc-lite/export`) hardcoded
  `color: [0.8, 0.8, 0.8, 1.0]` on every mesh and never looked at
  `materials[*].pbrMetallicRoughness.baseColorFactor`. After the
  GLB-export-dialog work ([#688](https://github.com/LTplus-AG/ifc-lite/issues/688)) wired colour authoring through the
  exporter end-to-end, a round-trip
  (IFC → GLB → re-import as model) silently lost all colour and the
  viewport went grey.

  Fix: resolve each primitive's `material` index against the glTF
  `materials` array and copy `baseColorFactor` into `MeshData.color`,
  keeping the previous grey as the fallback when a primitive has no
  material (e.g. third-party glTFs). Regression tests added in both
  packages cover the round-trip and the no-material fallback.

## 1.14.5

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Optimize memory usage by adding `CompactEntityIndexBuilder` for streaming entity index construction and `EntityTable.getTypeEnum()` for lightweight type lookups without full attribute extraction.

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162), [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b), [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/geometry@1.16.3
  - @ifc-lite/data@1.15.2

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/geometry@1.16.2

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/data@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/geometry@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/data@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/geometry@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/geometry@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/geometry@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/geometry@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/data@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/geometry@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/geometry@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/geometry@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/geometry@1.8.0

## 1.7.0

### Patch Changes

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

- Updated dependencies [[`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/data@1.7.0
  - @ifc-lite/geometry@1.7.0

## 1.6.0

### Minor Changes

- [#163](https://github.com/louistrue/ifc-lite/pull/163) [`95a96cb`](https://github.com/louistrue/ifc-lite/commit/95a96cb41b79253697a20380dbbae1450ee4c55a) Thanks [@github-actions](https://github.com/apps/github-actions)! - Add GLB file import support for fast geometry loading and 3D tool interoperability

  - Add GLB parser (parseGLB, loadGLBToMeshData) to cache package for importing pre-cached geometry
  - Enable round-trip workflows: IFC → GLB (export) → MeshData (import)
  - Support GLB files in viewer: upload, drag-and-drop, and multi-model federation
  - Detect GLB format via magic bytes (0x46546C67)

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

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

## 1.2.0

### Minor Changes

- ed8f77b: ### New Features

  - **Parquet-Based Serialization**: Implemented Parquet-based mesh serialization for ~15x smaller payloads
  - **BOS-Optimized Parquet Format**: Added ara3d BOS-optimized Parquet format for ~50x smaller payloads
  - **Data Model Extraction**: Implemented data model extraction and serialization to Parquet
  - **Server-Client Integration**: Added high-performance IFC processing server for Railway deployment with API information endpoint
  - **Cache Fast-Path**: Added cache fast-path to streaming endpoint for improved performance

  ### Performance Improvements

  - **Parallelized Serialization**: Parallelized geometry and data model serialization for faster processing
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing
  - **Enhanced Caching**: Enhanced data model handling and caching in Parquet processing

  ### Bug Fixes

  - **Fixed Background Caching**: Fixed data model background caching execution issues
  - **Fixed Cache Directory Detection**: Improved cache directory detection for local development

### Patch Changes

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

- Updated dependencies [f4fbf8c]
- Updated dependencies [f4fbf8c]
- Updated dependencies [ed8f77b]
- Updated dependencies [f7133a3]
  - @ifc-lite/geometry@1.2.0

## 1.2.0

### Minor Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Parquet-Based Serialization**: Implemented Parquet-based mesh serialization for ~15x smaller payloads
  - **BOS-Optimized Parquet Format**: Added ara3d BOS-optimized Parquet format for ~50x smaller payloads
  - **Data Model Extraction**: Implemented data model extraction and serialization to Parquet
  - **Server-Client Integration**: Added high-performance IFC processing server for Railway deployment with API information endpoint
  - **Cache Fast-Path**: Added cache fast-path to streaming endpoint for improved performance

  ### Performance Improvements

  - **Parallelized Serialization**: Parallelized geometry and data model serialization for faster processing
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing
  - **Enhanced Caching**: Enhanced data model handling and caching in Parquet processing

  ### Bug Fixes

  - **Fixed Background Caching**: Fixed data model background caching execution issues
  - **Fixed Cache Directory Detection**: Improved cache directory detection for local development

### Patch Changes

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

- Updated dependencies [[`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff)]:
  - @ifc-lite/geometry@1.2.0
