# @ifc-lite/parser

## 3.5.0

### Minor Changes

- [#1388](https://github.com/LTplus-AG/ifc-lite/pull/1388) [`8a4ce69`](https://github.com/LTplus-AG/ifc-lite/commit/8a4ce694ea1d8c1b0f25310f8a1addb3ff649f14) Thanks [@mehmet-ylcnky](https://github.com/mehmet-ylcnky)! - Re-export EntityTable and SpatialHierarchy types from @ifc-lite/data, allowing consumers to import store types directly from @ifc-lite/parser.

## 3.4.1

### Patch Changes

- [#1404](https://github.com/LTplus-AG/ifc-lite/pull/1404) [`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC2X3 `ePset_MapConversion` / `ePset_ProjectedCRS` georeferencing so the authored EPSG code is read (not a fallback `EPSG:4326`), and route those models into the Cesium / federation pipeline.

  IFC2X3 has no native `IfcMapConversion`/`IfcProjectedCRS`, so tools like `ifc-georeferencer` store georeferencing in property sets per the buildingSMART guide. Three bugs dropped these models to the legacy `IfcSite` lat/long (`EPSG:4326`), so two files differing only by CRS (`EPSG:7415` RD+NAP vs `EPSG:28992` RD) both displayed the same wrong CRS:

  - The pset-name match was case-sensitive (`ePSet_`/`EPset_`) and missed the real-world `ePset_` casing — now matched case-insensitively in both the TS (`extractGeoreferencing`) and Rust (`GeoRefExtractor`) extractors.
  - The ePSet path never read `ePset_ProjectedCRS.Name` (nor `MapConversion.TargetCRS`), so the EPSG code was discarded — now surfaced, with typed `IFCLABEL(...)`/`IFCLENGTHMEASURE(...)` values unwrapped.
  - The viewer's on-demand extractor never loaded the property sets at all — now pulls in the georef ePSets + their values (only when no `IfcMapConversion` exists, deferred-atom safe).

  The viewer's Cesium/federation gate accepts the `ePSetMapConversion` source, and ePSet offsets are scaled by the project length unit (millimetres for these files) so the model reprojects to the correct location instead of ~1000× out of range. The offline reproject fallback for the compound `EPSG:7415` (datum reported as `RD`) now carries the Kadaster `+towgs84` shift.

- Updated dependencies [[`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4)]:
  - @ifc-lite/wasm@2.13.4

## 3.4.0

### Minor Changes

- [#1347](https://github.com/LTplus-AG/ifc-lite/pull/1347) [`297ae7b`](https://github.com/LTplus-AG/ifc-lite/commit/297ae7bc232519fe06a25d6ea20f39290e8a7ed2) Thanks [@louistrue](https://github.com/louistrue)! - `SpatialHierarchyBuilder` is now the single source for spatial-hierarchy construction. Added `buildFromCache(entities, relationships)` for cache restores (no source buffer, so storey elevations stay empty and `getStoreyByElevation` returns null), alongside the existing `build(...)` for fresh parses. Both entry points share one `buildNode`, so they can no longer drift: the fresh path now also applies the aggregate-descendant storey mapping (an `IfcBuildingElementPart` under an `IfcWall` resolves to that wall's storey), and the cache path now also has the cyclic-`IfcRelAggregates` guard. The viewer's duplicate `rebuildSpatialHierarchy` becomes a thin wrapper over `buildFromCache`.

### Patch Changes

- Updated dependencies [[`c7c58c0`](https://github.com/LTplus-AG/ifc-lite/commit/c7c58c09e40fe40be5cc14cadf95beac18130ea5), [`18187fa`](https://github.com/LTplus-AG/ifc-lite/commit/18187facd6fa6fec15a23ef5e3263353730c5d8b)]:
  - @ifc-lite/wasm@2.13.2

## 3.3.2

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

- Updated dependencies [[`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/wasm@2.11.1

## 3.3.1

### Patch Changes

- [#1190](https://github.com/LTplus-AG/ifc-lite/pull/1190) [`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf) Thanks [@louistrue](https://github.com/louistrue)! - Recover from transient WASM engine-load failures and humanise the error.

  When the `ifc-lite_bg.wasm` binary fails to download (non-OK HTTP status, a cold
  CDN edge, a mid-deploy race, or a blocking proxy/antivirus), wasm-bindgen's
  streaming loader rethrows a cryptic `Failed to execute 'compile' on
'WebAssembly': HTTP status code is not ok`. The geometry and parser workers now
  retry `init()` once on such fetch/HTTP-shaped failures, and the viewer maps the
  failure to actionable guidance ("reload the page") instead of surfacing the raw
  TypeError. Captured exceptions are tagged with a stable `error_kind` for triage.

## 3.3.0

### Minor Changes

- [#1143](https://github.com/LTplus-AG/ifc-lite/pull/1143) [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278) Thanks [@louistrue](https://github.com/louistrue)! - Preserve source IFC HEADER fields on round-trip export. Re-exporting an
  imported file previously regenerated a fresh ifc-lite header, silently dropping
  the source `FILE_DESCRIPTION` items (any `ViewDefinition [...]` label and vendor
  identifier / coordinate-reference strings) and flattening the exact
  `FILE_SCHEMA` token (e.g. `IFC4X3_ADD2` → `IFC4X3`, which some toolchains
  reject).

  The parser now captures the verbatim HEADER onto a new
  `IfcDataStore.sourceHeader` (`IfcSourceHeader`, exported from `@ifc-lite/data`;
  parser also exports `parseSourceHeader`), threaded through the worker transport.
  `StepExporter` reproduces the source `FILE_DESCRIPTION` items and the exact
  `FILE_SCHEMA` token when not converting schemas, falling back to parsing the
  source bytes for cache-restored stores. Provenance stays honest:
  `preprocessor_version` is set to `ifc-lite` while the source authoring tool is
  kept as `originating_system`, and when mutations exist exactly one
  `Re-exported by ifc-lite, N modification(s)` item is appended without removing
  the source items. `generateHeader` now accepts description/author/organization
  arrays plus a free-form schema token and STEP-escapes all fields; it also emits
  a properly parenthesised `FILE_DESCRIPTION` list (the prior single-string form
  was malformed STEP). Created-from-scratch (`IfcCreator`) and federated/merged
  exports are unaffected — they keep their own provenance headers by design.

### Patch Changes

- [#1151](https://github.com/LTplus-AG/ifc-lite/pull/1151) [`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d) Thanks [@louistrue](https://github.com/louistrue)! - De-duplicate the STEP serializer into a single source of truth. The
  schema-agnostic STEP serialization logic (`serializeValue`, `generateHeader`,
  `parseStepValue`, `ref`/`enumVal`/`isEntityRef`/`isEnumValue`, and the
  registry-injected `toStepLineWithRegistry` / `generateStepFileWithRegistry`)
  previously existed as four hand-synced copies — the codegen template plus three
  generated `serializers.ts` files — which had already silently drifted (the
  runtime copy carried a `?? []` hardening the template lacked). It now lives once
  in `@ifc-lite/data`; the per-schema bundles (parser runtime + codegen outputs)
  are thin re-exports that only bind their own `SCHEMA_REGISTRY` to the
  registry-coupled helpers, so the copies can never diverge again. A codegen test
  asserts the generated bundle stays a thin re-export rather than re-inlining
  logic.

  Also fixes the broken `generate:ifc4` script (it pointed at a non-existent
  `schemas/IFC4.exp`; the real file is `schemas/IFC4_ADD2_TC1.exp`). No public
  behaviour change: `@ifc-lite/parser` re-exports the same serializer symbols as
  before; `@ifc-lite/data` gains the shared primitives; `@ifc-lite/codegen` now
  declares `@ifc-lite/data` as a dependency since the generated bundle imports it.

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0

## 3.2.0

### Minor Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Georeferencing TS↔Rust parity (alignment audit phase 1):

  - `@ifc-lite/parser`: `extractGeoreferencing` gains the IFC2x3 `ePSet_MapConversion` fallback with the same precedence as the Rust extractor (`IfcMapConversion` → ePSet → legacy `IfcSite` lat/long); `GeoreferenceInfo.source` union widens to include `'ePSetMapConversion'`.
  - `@ifc-lite/server-client`: `Georeferencing` gains optional `crs_description`, `map_zone`, `map_unit`, `map_unit_scale`, and `source` fields — the server now reports MapUnit-scaled conversions (e.g. 0.001 for millimetre-based files), picks the FIRST authored `IfcMapConversion` like the browser parser, normalises non-unit X-axis directions so `transform_matrix` agrees with `rotation_degrees`, and recognises site-only models via the `IfcSite.RefLatitude/RefLongitude` fallback.

- [#1076](https://github.com/LTplus-AG/ifc-lite/pull/1076) [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112) Thanks [@louistrue](https://github.com/louistrue)! - Add `createSyntheticDataStore()` — a typed factory for building a fully-typed
  `IfcDataStore` for synthetic / non-STEP models (GLB meshes, point-cloud scans).
  It assembles real `@ifc-lite/data` tables (empty, or a single synthetic entity
  row) and wires the lazy `getEntity` / `getEntitiesByType` / `getProperties` /
  `getQuantities` accessors through `attachDataStoreAccessors`, the same single
  source of truth the columnar parse / worker transport / cache restore use.

  The viewer's GLB (`createMinimalGlbDataStore`) and LAS/LAZ point-cloud
  (`emptyDataStore`) ingest paths now build their synthetic stores through this
  factory instead of whole-object `as unknown as IfcDataStore` casts. Those casts
  silently dropped the `IfcStoreBase` accessors, so a future required
  `IfcDataStore` member stayed green at the cast site and threw
  `TypeError: store.getProperties is not a function` at runtime on the
  GLB / point-cloud ingest flow (same crash class as [#950](https://github.com/LTplus-AG/ifc-lite/issues/950)). The contract is now
  compiler-enforced for these synthetic stores.

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

## 3.1.3

### Patch Changes

- [#1055](https://github.com/LTplus-AG/ifc-lite/pull/1055) [`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): make IDS validation usable on large models with code-list IDS packs.

  Validating a 550k-entity model against an 848-spec IDS document took ~19
  minutes of CPU, produced multi-GB reports, and the CLI then hung forever
  after printing its results. Four root fixes:

  - parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
    in Node an open `MessagePort` holds a libuv handle, so every CLI command
    on a large file kept the process alive after completion. Ports now close
    (helper consolidated into one shared module).
  - ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
    property sets / types / attributes are extracted once per entity instead
    of once per entity _per specification_ (O(specs×entities) source
    re-parses → O(entities)). Enumeration constraints additionally compile
    into exact-match sets (real-world code lists carry 800+ values).
  - ids: per-entity result strings are now bounded — enumeration constraints
    render at most 10 values in failure messages, and the entity-independent
    requirement description is formatted once per requirement instead of per
    entity result (reports for failing models dropped from GBs to MBs).
  - cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
    accessor (the drifted local copy missed type-inherited property sets),
    reports real progress (`spec 312/848 (37%)` instead of
    `undefined (undefined/undefined)`), and skips retaining passing entity
    results for human-readable output (`--json` is unchanged).

  Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
  now come from the validator's per-spec status, which counts
  cardinality-only failures — a `minOccurs="1"` specification that matches
  zero entities now correctly FAILs (exit 1) where it previously passed
  silently. `bim.ids.summarize` likewise prefers the per-spec status when
  the report carries one, so `--json` and text mode agree on the verdict.

  Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
  3.4min→12s, both with a clean exit instead of a hang.

## 3.1.2

### Patch Changes

- [#1048](https://github.com/LTplus-AG/ifc-lite/pull/1048) [`f4ad10f`](https://github.com/LTplus-AG/ifc-lite/commit/f4ad10f2fef12e720b0966060a928d0a4e2b32b1) Thanks [@louistrue](https://github.com/louistrue)! - fix(georef): apply IfcMapConversion.Scale to the height axis. Per IFC4x3,
  the map conversion scale applies equally to x, y and z, but
  computeTransformMatrix and transformToLocal left z unscaled — models whose
  source and map coordinate systems use different units placed geometry at
  the wrong elevation. (Same fix applied to the Rust GeoReference
  local_to_map/map_to_local/to_matrix, released with the crates.)
- Updated dependencies [[`71c3e92`](https://github.com/LTplus-AG/ifc-lite/commit/71c3e92bae778fe7e5c34d9fcce5abfbd4f3ede5), [`c003017`](https://github.com/LTplus-AG/ifc-lite/commit/c0030175e82f194183b60492c1de34eca6b5d691)]:
  - @ifc-lite/ifcx@2.1.5
  - @ifc-lite/wasm@2.6.0

## 3.1.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/ifcx@2.1.4
  - @ifc-lite/wasm@2.5.1

## 3.1.0

### Minor Changes

- [#980](https://github.com/LTplus-AG/ifc-lite/pull/980) [`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525) Thanks [@louistrue](https://github.com/louistrue)! - Add `attachDataStoreAccessors(store)`, the single home for wiring an `IfcDataStore`'s lazy `getEntity` / `getEntitiesByType` / `getProperties` / `getQuantities` accessors. The fresh-parse worker→main transport path now uses it instead of duplicating the wiring inline.

  This fixes a crash when querying a model loaded from the on-disk cache: the cache format only serialises data, so a restored store was missing these accessor methods, and opening the Properties panel for a cached entity threw `store.getEntity is not a function` (the viewer's cache-restore path now calls `attachDataStoreAccessors`).

- [#982](https://github.com/LTplus-AG/ifc-lite/pull/982) [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b) Thanks [@louistrue](https://github.com/louistrue)! - feat(materials): expose material property sets and a Materials inspector tab

  Material property sets attached to an `IfcMaterial` via `IfcMaterialProperties`
  (e.g. `Pset_MaterialConcrete`) are now resolved and shown:

  - **On the selected object** — a "Material Properties" group in the inspector,
    resolved through the element's material association (fanning a layer / profile /
    constituent set out to each member material), mirroring how type psets surface
    on an occurrence.
  - **A new "Materials" hierarchy tab** — lists every base material; selecting one
    isolates its elements and shows the material's own psets plus quantities
    (volume / area / weight) aggregated across all using elements, apportioned by
    each element's material share (layer thickness / constituent fraction).

  New parser exports: `extractMaterialPropertiesOnDemand`,
  `extractMaterialPropertiesForMaterialId`, `buildMaterialUsageIndex`,
  `collectMaterialLeaves`, `resolveMaterialDefId`, `getMaterialDisplay`, and the
  `MaterialPsetGroup` / `MaterialLeaf` / `MaterialUsage` types.

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
  - @ifc-lite/ifcx@2.1.3
  - @ifc-lite/wasm@2.3.0

## 3.0.0

### Major Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/ifcx@2.1.2

## 2.4.2

### Patch Changes

- [#834](https://github.com/LTplus-AG/ifc-lite/pull/834) [`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84) Thanks [@louistrue](https://github.com/louistrue)! - Three IFC geometry fixes plus a Dutch / metric-export properties-panel fix.

  - **[#820](https://github.com/LTplus-AG/ifc-lite/issues/820) — `IfcTrimmedCurve` parameter values now respect `PLANEANGLEUNIT`.**
    `process_trimmed_conic` previously called `.to_radians()` unconditionally,
    silently shrinking a 240° arc to ~4° on files that declare
    `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` (e.g. the Renga-exported
    `RadianValuesOverPI.ifc` wall whose trim values are `5.7596`/`9.9484`
    radians). Added `extract_plane_angle_to_radians` to `ifc_lite_core::units`
    and a lazy lookup on `EntityDecoder` so the right scale (1.0 for RADIAN
    files, π/180 for DEGREE conversion-based units) is applied without
    per-call IFC scanning.

  - **[#821](https://github.com/LTplus-AG/ifc-lite/issues/821) — `IfcBooleanResult.DIFFERENCE` falls back to the un-cut host when
    the subtract emits an empty mesh from a non-empty host.** Revit IFC2x3
    exports (e.g. `TallBuilding.ifc`) sometimes author top-trim
    `IfcPolygonalBoundedHalfSpace` planes that land exactly on the wall's top
    with `AgreementFlag = .T.`, making the spec-strict half-space material
    region exactly cover the wall body — the strict subtract returns nothing
    and the wall vanishes. Production viewers (BIMVision, IfcOpenShell) revert
    to the host in this case; the processor now does the same and records the
    loss as `BoolFailureReason::DifferenceEmptiedHost` so it surfaces in CSG
    diagnostics rather than disappearing silently.

  - **[#819](https://github.com/LTplus-AG/ifc-lite/issues/819) — `IfcTriangulatedFaceSet` flat-shades by default.** Without
    per-vertex `Normals` the downstream normal accumulator was smooth-averaging
    face normals across every shared vertex, smearing crisp facet edges into
    muddy gradients on faceted geometry (visible on the
    `IFC4TessellationComplex.ifc` dome compared to BIMVision's flat-shaded
    render). The processor now duplicates vertices per-triangle and writes
    per-face normals, matching what `IfcPolygonalFaceSet` already does and
    the IfcOpenShell / web-ifc default.

  - **Layer thickness display in the properties panel** (`MaterialCard`)
    showed "60.0 m" for a 60 mm prefab slab on `LENGTHUNIT=MILLI.METRE`
    files. `material-resolver` now multiplies the raw `IfcMaterialLayer.LayerThickness`
    by `store.lengthUnitScale` before storing it, so `formatThickness` sees a
    proper metres value and reports "60.0 mm".

  Adds three regression tests pinned to fixtures under `tests/models/issues/`:

  - `issue_819_triangulated_normals.rs`
  - `issue_820_trimmed_curve_planeangleunit.rs`
  - `issue_821_difference_emptied_host.rs`

  Catalogue updated; fixtures will be uploaded to the `fixtures-v1` release.

- Updated dependencies [[`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84), [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3)]:
  - @ifc-lite/wasm@1.19.1

## 2.4.1

### Patch Changes

- [#658](https://github.com/louistrue/ifc-lite/pull/658) [`bfb5e1b`](https://github.com/louistrue/ifc-lite/commit/bfb5e1bdc917ab771de4540b6c5686b9fb0e5fa7) Thanks [@louistrue](https://github.com/louistrue)! - Restore IFC2X3 georeferencing extraction from legacy site locations and standard map conversion data so Cesium placement and inspector metadata stay available for older models.

## 2.4.0

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

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/data@1.17.0
  - @ifc-lite/ifcx@2.1.1

## 2.3.0

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

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/ifcx@2.1.0

## 2.2.0

### Minor Changes

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC 4D / construction scheduling extractor (`extractScheduleOnDemand`).
  Parses `IfcTask`, `IfcTaskTime`, `IfcRelSequence`, `IfcRelAssignsToProcess`,
  `IfcRelAssignsToControl`, `IfcRelNests`, `IfcWorkSchedule`, `IfcWorkPlan`, and
  `IfcLagTime` from the source buffer and returns a normalized
  `ScheduleExtraction` — hierarchy, assigned products, typed dependency edges
  (FS/SS/FF/SF with `IfcLagTime` resolved to seconds), and work-schedule
  grouping — that UIs can drive a Gantt view and 4D animation from.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add schedule-serializer + deterministic-GlobalId helpers.

  **`serializeScheduleToStep(extraction, options)`** emits a `ScheduleExtraction`
  back into IFC-STEP lines (`IfcWorkSchedule`, `IfcWorkPlan`, `IfcTask`,
  `IfcTaskTime`, `IfcRelNests`, `IfcRelSequence`, `IfcLagTime`,
  `IfcRelAssignsToControl`, `IfcRelAssignsToProcess`), resolving cross-entity
  references by expressId and reporting per-type line counts in `stats`.
  Pairs with the existing `extractScheduleOnDemand` to make schedule data
  fully round-trippable through a STEP export.

  **`deterministicGlobalId(seed)`** — 128-bit double-FNV-1a hash encoded as a
  22-char IFC GlobalId. Deterministic (same seed ⇒ same id), collision-safe
  across schedule-generation seeds, and exposed as a single source of truth
  for every caller that previously kept a private copy of the algorithm.

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

- [#578](https://github.com/louistrue/ifc-lite/pull/578) [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04) Thanks [@louistrue](https://github.com/louistrue)! - Surface on-demand properties and quantities through the query API.

  `parseColumnar` intentionally leaves the pre-parsed `store.properties` / `store.quantities` tables empty and populates `onDemandPropertyMap` / `onDemandQuantityMap` instead, but `QueryResultEntity` only read from the empty pre-parsed tables. As a result `query.ofType(...).includeProperties().includeQuantities().execute()` always returned elements with empty `properties` / `quantities`, even when the IFC file contained them (issue #577).

  `loadPropertiesFromStore` / `loadQuantitiesFromStore` in `query-result-entity.ts` now fall back to `extractPropertiesOnDemand` / `extractQuantitiesOnDemand` when the pre-parsed tables are empty and the on-demand maps are present. This applies to the `properties` / `quantities` getters, the `loadProperties` / `loadQuantities` eager loaders, and the `getProperty()` accessor.

  Also normalizes untagged STEP enumeration tokens (`.T.` / `.F.` / `.U.` / `.X.`) emitted by some authoring tools in the `NominalValue` slot of `IfcPropertySingleValue`: `.T.` / `.F.` now decode to real JS booleans and `.U.` / `.X.` to a Logical `null`, matching the behavior of the conformant `IFCBOOLEAN(...)` / `IFCLOGICAL(...)` typed form.

## 2.1.9

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 2.1.8

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Fix parser entity index regression and remove debug console statements from production code.

## 2.1.7

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Optimize memory usage by adding `CompactEntityIndexBuilder` for streaming entity index construction and `EntityTable.getTypeEnum()` for lightweight type lookups without full attribute extraction.

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/data@1.15.2

## 2.1.6

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/ifcx@2.0.2

## 2.1.5

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/encoding@1.14.5

## 2.1.4

### Patch Changes

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Recognize IFC4.3 facility and facility-part spatial containers when building parser hierarchies so infrastructure models render a usable spatial tree.

- Updated dependencies [[`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9)]:
  - @ifc-lite/data@1.14.6

## 2.1.3

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/data@1.14.5

## 2.1.2

### Patch Changes

- [#372](https://github.com/louistrue/ifc-lite/pull/372) [`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078) Thanks [@louistrue](https://github.com/louistrue)! - Fix multiple CLI bugs and add new query features:

  **Bug fixes:**

  - **info/diff**: Resolve "Unknown" entity type spam by using IFC_ENTITY_NAMES map for UPPERCASE→PascalCase conversion
  - **loader**: Reject non-IFC files (missing ISO-10303-21 header) and empty files with clear error messages
  - **props**: Return proper error for nonexistent entity IDs instead of empty JSON structure
  - **bcf list**: Fix empty topics by adding Map serialization support to JSON output
  - **query --where**: Fix boolean property matching (IsExternal=true now works); error on malformed syntax instead of silently returning all results
  - **query --relationships**: Add structural relationship types (VoidsElement, FillsElement, ConnectsPathElements, AssignsToGroup, etc.) to parser; handle 1-to-1 relationships
  - **query --spatial**: Fall back to IfcBuilding containment when no IfcBuildingStorey exists
  - **eval**: Support const/let/var and multi-statement expressions (auto-wraps in async IIFE)
  - **model.active().schema**: Add `schema` alias so scripts can access schema version

  **New features:**

  - **query --where operators**: Support `!=`, `>`, `<`, `>=`, `<=`, `~` (contains) in addition to `=`
  - **query --sum**: Aggregate a quantity across matched entities with disambiguation warnings when similar quantities exist (e.g., `--sum GrossSideArea`)
  - **query --storey**: Filter entities by storey name (e.g., `--storey Erdgeschoss`)
  - **query --quantity-names**: List all available quantities per entity type with qset context, sample values, and ambiguity warnings — critical for LLM-driven quantity analysis
  - **query --group-by**: Pivot table grouped by type, material, or any property (e.g., `--group-by material`)
  - **query --spatial --summary**: Show element type counts per storey instead of listing every element
  - **eval**: Auto-return last expression value in multi-statement mode (no explicit `return` needed)
  - **validate**: Check quantity completeness — warns when building elements lack quantity sets
  - **--version**: Show version number in help output

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4

## 2.1.1

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

## 2.1.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Replace hardcoded IFC schema with codegen from EXPRESS schema, adding full type entity support (776 entities)

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87)]:
  - @ifc-lite/ifcx@2.0.1
  - @ifc-lite/encoding@1.14.4

## 2.0.0

### Major Changes

- [#336](https://github.com/louistrue/ifc-lite/pull/336) [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5) Thanks [@louistrue](https://github.com/louistrue)! - Remove the legacy single-parent `ComposedNode.parent` field and `getPathToRoot()` export from the IFCX composition API. IFCX extraction now relies on explicit traversal frames instead of mutable parent pointers, and the build now verifies built `dist` output against the Hello Wall IFCX fixtures.

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5), [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/ifcx@2.0.0

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.3
  - @ifc-lite/ifcx@1.14.3

## 1.14.2

### Patch Changes

- [#316](https://github.com/louistrue/ifc-lite/pull/316) [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC type detection for style-based IFC2X3 entities and keep type-owned property extraction consistent with mixed-source type metadata.

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/ifcx@1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

- Updated dependencies []:
  - @ifc-lite/data@1.14.1
  - @ifc-lite/ifcx@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/ifcx@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/ifcx@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/ifcx@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/ifcx@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/ifcx@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/ifcx@1.11.0

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
  - @ifc-lite/data@1.10.0
  - @ifc-lite/ifcx@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/ifcx@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/ifcx@1.8.0

## 1.7.0

### Minor Changes

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

- Updated dependencies [[`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/data@1.7.0
  - @ifc-lite/ifcx@1.7.0

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

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

- Updated dependencies [[`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302)]:
  - @ifc-lite/data@1.3.0
  - @ifc-lite/ifcx@1.3.0

## 1.2.1

### Patch Changes

- 8cb195d: Fix Ubuntu setup issues and monorepo resolution.
  - Fix `@ifc-lite/parser` worker resolution for Node.js/tsx compatibility
  - Fix `create-ifc-lite` to properly replace `workspace:` protocol in templates

## 1.2.0

### Minor Changes

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

### Patch Changes

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- ### Bug Fixes

  - **Fixed IFC elevation units**: IFC files store elevation values in the file's native units (e.g., mm), but they were being displayed as meters without conversion. Now properly extracts and applies length unit scale from IFCPROJECT -> IFCUNITASSIGNMENT -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT, supporting SI prefixes (MILLI, CENTI, etc.) and imperial units (FOOT, INCH).
  - **Fixed IFCMEASUREWITHUNIT scale**: When extracting conversion factors from IFCMEASUREWITHUNIT, the ValueComponent is now correctly multiplied by the UnitComponent's scale factor (e.g., INCH defined as 25.4mm = 0.0254m).
  - **Fixed missing IFCUNITASSIGNMENT handling**: Added guards against missing IFCUNITASSIGNMENT attributes to prevent parsing errors.

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

- Updated dependencies [ed8f77b]
  - @ifc-lite/ifcx@1.2.0

## 1.2.0

### Minor Changes

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

### Patch Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

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

- Updated dependencies [[`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5)]:
  - @ifc-lite/ifcx@1.2.0
