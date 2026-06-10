# @ifc-lite/server-bin

## 1.16.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 1.16.1

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

## 1.16.0

### Minor Changes

- [#908](https://github.com/LTplus-AG/ifc-lite/pull/908) [`63a577f`](https://github.com/LTplus-AG/ifc-lite/commit/63a577f60941ea3dbfc2b75739bd322b41717f41) Thanks [@louistrue](https://github.com/louistrue)! - Expand the Server data model with **classifications**, **structured materials**,
  and **documents**, continuing the `@ifc-lite/parse` parity work (issue [#900](https://github.com/LTplus-AG/ifc-lite/issues/900)).

  The browser parser exposes these via `extractClassifications` / `extractMaterials`
  / `extractDocumentsOnDemand`, but the server's data model only recorded the bare
  `IfcRelAssociatesMaterial` relationship triple (and nothing for classifications or
  documents). Now each is resolved into a flat, element-keyed shape on the data
  model fetched from `GET /api/v1/parse/data-model/{cache_key}`.

  Server (shipped in the `@ifc-lite/server-bin` binary), in `extract_data_model`:

  - **Classifications** (`IfcRelAssociatesClassification` → `IfcClassificationReference`):
    element id, code (`Identification`), reference name, location, and the owning
    system name (resolved by walking `ReferencedSource` to `IfcClassification`).
  - **Materials** (`IfcRelAssociatesMaterial`): resolves `IfcMaterial`,
    `IfcMaterialLayerSet(Usage)`, `IfcMaterialList`, and `IfcMaterialConstituentSet`
    into per-layer rows — set name, layer index, material name, **thickness in
    metres** (unit-scaled), `IsVentilated`, and category.
  - **Documents** (`IfcRelAssociatesDocument` → `IfcDocumentReference` /
    `IfcDocumentInformation`): identification, name, location, description.

  Each becomes a new Parquet table appended to the data-model payload. The tables
  are appended **after** the existing five, so the format stays backward
  compatible — older clients ignore the trailing bytes, and the updated decoder
  reads them only when present (no data-model cache-version bump, so no stale-cache
  `202` trap; new data appears once a file is reprocessed).

  Client (`@ifc-lite/server-client`):

  - New `ClassificationAssociation`, `MaterialAssociation`, `DocumentAssociation`
    types; `DataModel` gains `classifications`, `materials`, `documents` (empty when
    served by an older server/cache).

  Regression coverage: `data_model.rs` unit tests assert a wall with a two-layer
  material set (mm → metre thickness scaling), a Uniclass classification reference
  (system name resolved through `ReferencedSource`), and a document reference are
  all extracted and element-keyed.

- [#907](https://github.com/LTplus-AG/ifc-lite/pull/907) [`ce477ed`](https://github.com/LTplus-AG/ifc-lite/commit/ce477ed8c5b8320b4e9eb40c2b89ca97290e1830) Thanks [@louistrue](https://github.com/louistrue)! - Surface georeferencing and the length-unit scale from the Server's geometry
  endpoints, continuing the `@ifc-lite/parse` parity work (issue [#900](https://github.com/LTplus-AG/ifc-lite/issues/900)).

  The browser parser exposes `IfcMapConversion` / `IfcProjectedCRS` georeferencing
  (`extractGeoreferencing`) and the length-unit scale (`extractLengthUnitScale`),
  but the server returned only a coarse `is_geo_referenced` boolean and kept the
  unit scale internal. Both are now carried inline on `ModelMetadata`, so they
  reach **every** geometry endpoint at once (JSON, SSE, Parquet, optimized Parquet,
  and the cached-geometry paths) — no new endpoint or fetch round-trip.

  Server (shipped in the `@ifc-lite/server-bin` binary):

  - `ModelMetadata` gains `length_unit_scale: Option<f64>` and
    `georeferencing: Option<Georeferencing>` (CRS name / geodetic + vertical datum
    / map projection, false eastings/northings, orthogonal height, X-axis
    direction, scale, derived grid-north `rotation_degrees`, and a column-major
    local→map `transform_matrix`).
  - Georeferencing reuses the existing shared `ifc_lite_core::GeoRefExtractor`
    (the same extraction the native/desktop paths use, including the IFC2x3
    `ePSet_MapConversion` fallback) via a new `ifc_lite_processing::extract_georeferencing`.
  - Populated in the shared geometry pipeline (`process_geometry_filtered`) and the
    server's streaming `Complete` event (extracted on a blocking thread).

  Client (`@ifc-lite/server-client`):

  - New `Georeferencing` type; `ModelMetadata` gains optional `length_unit_scale`
    and `georeferencing`.

  Regression coverage: `rust/processing/tests/issue_900_georeferencing_metadata.rs`
  asserts a georeferenced metre model surfaces the CRS + offsets + rotation and a
  millimetre model reports `length_unit_scale = 0.001` with no georeferencing, plus
  unit tests in `georeferencing.rs`.

- [#906](https://github.com/LTplus-AG/ifc-lite/pull/906) [`99003e0`](https://github.com/LTplus-AG/ifc-lite/commit/99003e09489e6fbc67b676f07749b1dfe745d5e9) Thanks [@louistrue](https://github.com/louistrue)! - Expose the 2D symbol stream (`IfcAnnotation` + `IfcGrid`) from **all** Server
  geometry/parsing endpoints, not just `POST /api/v1/parse` (issue [#900](https://github.com/LTplus-AG/ifc-lite/issues/900)).

  Issue [#843](https://github.com/LTplus-AG/ifc-lite/issues/843) added `symbolic_data` to the synchronous JSON parse response, but the
  streaming and binary-Parquet endpoints still dropped it, so consumers couldn't
  get IfcAnnotation/IfcGrid data unless they used that one endpoint. This brings
  the whole API to parity with `@ifc-lite/parse`.

  Server (shipped in the `@ifc-lite/server-bin` binary):

  - `POST /api/v1/parse/stream` and `POST /api/v1/parse/parquet-stream` now carry
    `symbolic_data` in their `complete` SSE event. It's extracted once at the end
    of the shared streaming pipeline (`process_streaming`), so both endpoints get
    it without re-parsing.
  - `POST /api/v1/parse/parquet` and `POST /api/v1/parse/parquet/optimized` extract
    the symbol stream alongside geometry (in parallel via `rayon::join`) and cache
    it under `{cache_key}-symbolic-v1`.
  - New `GET /api/v1/parse/symbolic/{cache_key}` returns the symbol stream as JSON
    for the binary transports whose payloads can't carry it inline — mirroring how
    the data model is cached and fetched (`/api/v1/parse/data-model/{cache_key}`).
    Returns `202` while a streaming upload is still caching in the background.
  - `POST /api/v1/parse` and the cached-geometry fast paths populate the same
    `{cache_key}-symbolic-v1` entry, so the fetch endpoint works regardless of
    which endpoint first processed the file.

  Symbol data can be large for annotation-heavy drawings, so it travels in the
  response body / SSE payload (JSON paths) or via the dedicated fetch endpoint
  (binary paths) — never an HTTP header.

  The parquet geometry cache version is bumped (`v2` → `v3`) so models cached
  before the symbolic sidecar existed are reprocessed once and get their
  `{cache_key}-symbolic-v1` companion written, instead of serving symbol-less
  geometry while the symbolic endpoint returns `202` forever.

  Client (`@ifc-lite/server-client`):

  - New `SymbolicData` type (plus `SymbolicGridAxis`, `SymbolicPolyline`,
    `SymbolicCircle`, `SymbolicText`, `SymbolicFillArea`).
  - `symbolic_data?` added to `ParseResponse`, `StreamCompleteEvent`,
    `ParquetStreamCompleteEvent`, and `ParquetStreamResult`.
  - New `client.fetchSymbolic(cacheKey)` method (parallel to `fetchDataModel`) for
    the binary Parquet transports; `parseParquetStream` now returns `symbolic_data`
    on its result (inline from the stream, or fetched on the cache-hit fast path).

  Regression coverage: in-process HTTP integration tests
  (`apps/server/src/parity_tests.rs`) drive a grid + annotation + wall fixture
  through `/parse`, `/parse/parquet`, `/parse/parquet/optimized`, the new symbolic
  endpoint, and `process_streaming`, asserting each surfaces the grid axes and
  annotation circle.

## 1.15.0

### Minor Changes

- [#887](https://github.com/LTplus-AG/ifc-lite/pull/887) [`175f8e3`](https://github.com/LTplus-AG/ifc-lite/commit/175f8e3ed93acba35f2efcb57993dd137ff7a241) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4x3 `IfcGridPlacement` so products laid out on a structural grid
  land on their grid-axis intersections instead of stacking at world origin
  (issue [#883](https://github.com/LTplus-AG/ifc-lite/issues/883)).

  The fix is in the shared `ifc-lite-geometry` Rust crate, so it ships on both
  surfaces that compile it: the WebAssembly build (`@ifc-lite/wasm`) and the
  native server binary downloaded by `@ifc-lite/server-bin` (pinned to its own
  package version, so it needs the bump to pull a rebuilt binary). The desktop
  app (Tauri) and the Docker server image compile the same crate and pick the
  fix up through their own build pipelines.

  The placement resolver dispatched only on `IfcLocalPlacement` and
  `IfcLinearPlacement` — every other placement type fell through to identity.
  The reporter's `ifcgrid.ifc` placed 25 `IfcColumn`s via
  `IfcGridPlacement → IfcVirtualGridIntersection`, so they all collapsed onto
  the same spot instead of spreading across the grid.

  This change:

  - Recognises `IfcGridPlacement` in the placement resolver. `PlacementRelTo`
    (the grid's own placement) composes exactly like `IfcLocalPlacement`;
    `PlacementLocation (IfcVirtualGridIntersection)` is resolved by reading the
    two referenced `IfcGridAxis` curves, intersecting them in the grid plane,
    applying the per-axis lateral `OffsetDistances` (each axis shifted along its
    left normal) and the optional elevation, then composing `parent * local`.
  - Implements full `IfcGridPlacementDirectionSelect` coverage for
    `PlacementRefDirection`: an `IfcDirection` sets local +X directly; an
    `IfcVirtualGridIntersection` points local +X from the placement location to
    that second intersection; null / unresolved inherits the grid orientation.

  Out of scope (documented in code):

  - Grid axes are treated as straight lines (chord of the first→last curve
    sample); curved axes would need arc-length sampling.

  Regression coverage:

  - `grid_placement_tests` in `rust/geometry/src/router/transforms.rs` — inline
    unit tests that assert the resolved transform directly: the axis-intersection
    origin, both `PlacementRefDirection` variants, the `OffsetDistances`
    perpendicular shift + elevation, and `PlacementRelTo` composition. No
    committed fixture (per AGENTS.md §9); the unit tests are self-contained.

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.14.3

### Patch Changes

- [#330](https://github.com/louistrue/ifc-lite/pull/330) [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `@ifc-lite/parser` runtime dependency from `@ifc-lite/mutations`, switch `@ifc-lite/server-bin` postinstall to a safe ESM dynamic import, and refresh the published `@ifc-lite/wasm` bindings and binary so the npm package stays in sync with the current Rust sources.

## 1.14.2

## 1.14.1

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages
