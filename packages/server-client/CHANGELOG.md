# @ifc-lite/server-client

## 1.19.0

### Minor Changes

- [#1778](https://github.com/LTplus-AG/ifc-lite/pull/1778) [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3) Thanks [@louistrue](https://github.com/louistrue)! - Server-parse path now resolves the Lists attribute columns `Description`, `ObjectType`, `PredefinedType`, and `Tag` identically to the in-browser (WASM) path ([#1765](https://github.com/LTplus-AG/ifc-lite/issues/1765)). The server extracts them at the SAME schema-registry positions the WASM path resolves attribute names against — via a Rust index table generated from `@ifc-lite/parser`'s `SCHEMA_REGISTRY` (`scripts/generate-server-attr-indices.mjs`) — so the traps hold on both paths: `IfcSite` attr 7 (LongName) never surfaces as Tag, `IfcWallType` attr 4 (ApplicableOccurrence) never surfaces as ObjectType, and `CompositionType` enums never leak into PredefinedType. Data-model payload bumped to v4 with nullable `description`/`object_type`/`tag`/`predefined_type` entity columns; `@ifc-lite/data`'s `EntityTable` gains optional `getTag`/`getPredefinedType` accessors (server-parsed stores implement them; the WASM path keeps its on-demand source extraction).

- [#1759](https://github.com/LTplus-AG/ifc-lite/pull/1759) [`e49a1a0`](https://github.com/LTplus-AG/ifc-lite/commit/e49a1a020eaafd397af626e88a058b69122a1bd9) Thanks [@louistrue](https://github.com/louistrue)! - Server-parse path now resolves Type-level properties/QTOs in Lists/Schedules identically to the in-browser (WASM) path ([#1751](https://github.com/LTplus-AG/ifc-lite/issues/1751)), and adds a `Type` list column showing the element's IfcTypeProduct name ([#1754](https://github.com/LTplus-AG/ifc-lite/issues/1754)).

  Two things were broken on the server path and are fixed together:

  - **Every text/boolean property was garbled.** The server's property extractor only matched bare strings/numbers, so STEP's typed wrappers (`IFCLABEL('X')`, `IFCBOOLEAN(.T.)`) fell through to a Rust `Debug` string typed `"unknown"`. It now mirrors the WASM `parsePropertyValue` — resolving canonical value + kind (`string`/`boolean`/`logical`/`integer`/`real`) and carrying the raw measure tag (`data_type`, e.g. `IFCLENGTHMEASURE`) — so numeric cells sum/sort and unit conversion ([#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)) works. `@ifc-lite/server-client`'s `Property` gains an optional `data_type` (data-model payload bumped to v3).

  - **Type sets never reached the client.** The server dropped `IfcRelDefinesByType` and never read a type's `HasPropertySets`. It now emits the type→element relationship plus a synthetic `TYPEHASPROPERTYSETS` edge per type-owned set, and the viewer merges those onto the type id (own sets first, name-deduped) — matching the WASM path exactly.

  `@ifc-lite/lists` adds a `Type` attribute column and an optional `getEntityDefiningTypeName` accessor on `ListDataProvider`. A cross-path parity test asserts identical `executeList` rows, column metadata, and group sums for the same file through both parse paths.

## 1.18.3

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 1.18.2

### Patch Changes

- [#1651](https://github.com/LTplus-AG/ifc-lite/pull/1651) [`52d861c`](https://github.com/LTplus-AG/ifc-lite/commit/52d861cdace765965dc79953916403b3ab0e3da6) Thanks [@louistrue](https://github.com/louistrue)! - Surface the rect-fast `deferTooManyOpenings` counter in the geometry diagnostics. The Rust `RectFastSummary` already emits it (the opening-count DoS cap, [#1649](https://github.com/LTplus-AG/ifc-lite/issues/1649)); the `GeometryDiagnostics.rectFast` and server-client types now include it (optional, defaulted to 0 when absent so older payloads merge cleanly), `mergeGeometryDiagnostics` sums it, and the CLI geometry report renders it in the rect_fast defer breakdown.

## 1.18.1

### Patch Changes

- [#1502](https://github.com/LTplus-AG/ifc-lite/pull/1502) [`7d5a031`](https://github.com/LTplus-AG/ifc-lite/commit/7d5a03191a768f68c5ddad878698d1aacb9940ef) Thanks [@louistrue](https://github.com/louistrue)! - fix(server-client): send the auth token on data-model and symbolic fetches

  `fetchDataModel` and `fetchSymbolic` were the only requests that omitted
  `authHeaders()`, so against a server started with `IFC_SERVER_API_TOKEN` the
  geometry parse succeeded but the follow-up data-model and symbolic fetches got
  401 and silently returned null — the model loaded with no properties and no
  annotations. Both now send the `Authorization` header like every other request.

  Also: the streaming parse cache-check now includes the parse query string
  (`parseQuery(options)`), matching the non-streaming path, so a cached result for
  a different tessellation quality is no longer returned as a hit.

## 1.18.0

### Minor Changes

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

## 1.17.1

### Patch Changes

- [#1404](https://github.com/LTplus-AG/ifc-lite/pull/1404) [`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC2X3 `ePset_MapConversion` / `ePset_ProjectedCRS` georeferencing so the authored EPSG code is read (not a fallback `EPSG:4326`), and route those models into the Cesium / federation pipeline.

  IFC2X3 has no native `IfcMapConversion`/`IfcProjectedCRS`, so tools like `ifc-georeferencer` store georeferencing in property sets per the buildingSMART guide. Three bugs dropped these models to the legacy `IfcSite` lat/long (`EPSG:4326`), so two files differing only by CRS (`EPSG:7415` RD+NAP vs `EPSG:28992` RD) both displayed the same wrong CRS:

  - The pset-name match was case-sensitive (`ePSet_`/`EPset_`) and missed the real-world `ePset_` casing — now matched case-insensitively in both the TS (`extractGeoreferencing`) and Rust (`GeoRefExtractor`) extractors.
  - The ePSet path never read `ePset_ProjectedCRS.Name` (nor `MapConversion.TargetCRS`), so the EPSG code was discarded — now surfaced, with typed `IFCLABEL(...)`/`IFCLENGTHMEASURE(...)` values unwrapped.
  - The viewer's on-demand extractor never loaded the property sets at all — now pulls in the georef ePSets + their values (only when no `IfcMapConversion` exists, deferred-atom safe).

  The viewer's Cesium/federation gate accepts the `ePSetMapConversion` source, and ePSet offsets are scaled by the project length unit (millimetres for these files) so the model reprojects to the correct location instead of ~1000× out of range. The offline reproject fallback for the compound `EPSG:7415` (datum reported as `RD`) now carries the Kadaster `+towgs84` shift.

## 1.17.0

### Minor Changes

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

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Georeferencing TS↔Rust parity (alignment audit phase 1):

  - `@ifc-lite/parser`: `extractGeoreferencing` gains the IFC2x3 `ePSet_MapConversion` fallback with the same precedence as the Rust extractor (`IfcMapConversion` → ePSet → legacy `IfcSite` lat/long); `GeoreferenceInfo.source` union widens to include `'ePSetMapConversion'`.
  - `@ifc-lite/server-client`: `Georeferencing` gains optional `crs_description`, `map_zone`, `map_unit`, `map_unit_scale`, and `source` fields — the server now reports MapUnit-scaled conversions (e.g. 0.001 for millimetre-based files), picks the FIRST authored `IfcMapConversion` like the browser parser, normalises non-unit X-axis directions so `transform_matrix` agrees with `rotation_degrees`, and recognises site-only models via the `IfcSite.RefLatitude/RefLongitude` fallback.

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Server pipeline parity (alignment audit follow-up):

  - New `ParseRequestOptions.tessellationQuality` option on `parse` / `parseParquet` / `parseParquetStream` / `parseParquetOptimized` / `parseStream` — the server now honours the same `lowest…highest` detail levels the wasm path exposes via `setTessellationQuality` ([#976](https://github.com/LTplus-AG/ifc-lite/issues/976)'s server half). Default stays `medium`, byte-identical to historical output, and maps to the pre-existing cache keys.
  - The cached-geometry fast path forwards the quality option, so a `high` request can never be served a `medium` cache entry.
  - Fixed the "[client] Cache key mismatch" warning that fired on every fresh upload: the server cache key is the file hash plus request suffixes, so the sanity check now verifies derivation instead of equality.

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
