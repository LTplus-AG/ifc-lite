# @ifc-lite/server-client

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

## 1.15.3

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 1.15.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.15.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

## 1.15.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

## 1.14.3

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
