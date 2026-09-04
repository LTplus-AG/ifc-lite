# @ifc-lite/server-bin

## 1.17.0

### Minor Changes

- [#3894](https://github.com/LTplus-AG/ifc-lite/pull/3894) [`55fab2c`](https://github.com/LTplus-AG/ifc-lite/commit/55fab2c87ea263d50d1b1239971aecafb6e6ed2e) Thanks [@louistrue](https://github.com/louistrue)! - `POST /api/v1/parse/parquet/optimized` is now cached, so a repeat request is a disk read instead of a full re-parse ([#3889](https://github.com/LTplus-AG/ifc-lite/issues/3889)). The route was added without a cache key of its own, which left the two Parquet endpoints with opposite properties: the flat route stored its large payload and replayed it, while the optimized route rebuilt its small payload on every request, and got no benefit from a flat response cached seconds earlier either. On a 57.9 MB file the flat route roughly halved on its second call and the optimized route did not improve at all.
  
  The optimized response now has its own key pair, `{sha256}-{filter}-parquet-optimized-v1` for the body and `{sha256}-{filter}-parquet-optimized-metadata-v1` for the `X-IFC-Metadata` header, `optimization_stats` included, so a replay reports what the live parse reported. They are a separate namespace from the flat route's `-parquet-v5` / `-parquet-metadata-v4` on purpose: the optimized payload is quantized and deduplicated, so a cached flat response must never satisfy the optimized route or the other way round. Bump the suffix on any change to the optimized payload's columns.
  
  Two details of the write. It happens before the response goes out rather than in a background task, because this payload is the small one and a background write races the very next request, which is the request the cache exists to serve. And a hit requires the symbolic sidecar to still be present alongside the body and metadata: the optimized parse is what writes that sidecar, so replaying past a missing one would leave `GET /api/v1/parse/symbolic/{cache_key}` polling a key nobody writes.

- [#3904](https://github.com/LTplus-AG/ifc-lite/pull/3904) [`34aacc6`](https://github.com/LTplus-AG/ifc-lite/commit/34aacc689d26cbaa15c3bdd4c06d5c710f5676c6) Thanks [@louistrue](https://github.com/louistrue)! - `POST /api/v1/parse/parquet` can now share geometry between occurrences of one shape, behind the opt-in `?parquet_layout=shared-shapes` ([#3888](https://github.com/LTplus-AG/ifc-lite/issues/3888)). The flat writer emitted one full copy of the vertices per occurrence, so a model built from repeated furniture, pipe runs or structural members paid for every repeat. `/optimized` has deduplicated those since [#3595](https://github.com/LTplus-AG/ifc-lite/issues/3595); the flat route, which is the one a viewer replays from cache on every open after the first, was scoped out of that work.
  
  Under the new layout the mesh table gains `rot0..rot8` (row-major 3x3, Float32) and its `vertex_start`/`vertex_count`/`index_start`/`index_count` stop being one-to-one with the blocks they name: several rows can point at one block, each placed by `world = origin + R * p` in the same Y-up metres frame the positions are already in. The grouping is `collate_rotation_aware_placements` reused verbatim, so the flat route can never share a shape the optimized route would have refused to: same representation-identity grouping, same per-vertex residual check against the occurrence's own baked geometry, same all-or-nothing per group. On `S_Office_Integrated Design Archi.ifc` the blob goes from 23,577,415 to 4,923,656 bytes, 20.9% of the previous size.
  
  **It is opt-in, and a request that does not ask for it gets byte-identical output to before.** The layout renders incorrectly on a client that does not apply the rotation — every occurrence of a shared shape lands at the template's placement — and the flat Parquet wire carries no version marker such a client could fail loud on, unlike `/optimized`. A server cannot tell those clients apart, so producing the new layout by default would silently draw the wrong building for anyone pinned to an older `@ifc-lite/server-client`. A cache-key bump would not have helped: a key namespaces server-side entries and has no bearing on which client is asking.
  
  The two layouts are cached under separate keys, `-parquet-v5` (unchanged, so entries already on disk still hit) and `-parquet-v6`, and never cross-serve. `GET /api/v1/cache/check/{hash}` and `GET /api/v1/cache/geometry/{hash}` take the same `parquet_layout` parameter and answer for the layout the caller asked about, so a default client cannot be told "cached" about an entry it would draw wrong.
  
  `POST /api/v1/parse/parquet-stream` honours the parameter too, but shares nothing under either value: it serializes one batch at a time, where sharing could only be batch-local. There the parameter decides only whether the mesh table carries identity rotation columns, which keeps everything under the v6 key a v6 payload.

- [#3595](https://github.com/LTplus-AG/ifc-lite/pull/3595) [`cfee55b`](https://github.com/LTplus-AG/ifc-lite/commit/cfee55b287075eddbe10cc37d4c0d70caaac7279) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `POST /api/v1/parse/parquet/optimized`'s documented "Mesh deduplication (instancing)" was inert whenever reuse was rotational: the dedup key hashed each occurrence's BAKED (world-space) vertices, and rotation is baked into those vertices, so two instances of one shape at different orientations always hashed distinct. Across models with heavy `IfcMappedItem` reuse (furniture, pipe runs, repeated structural members) `optimization_stats.mesh_reuse_ratio` sat at ~1.0 where 3.6x-72x reuse was available.
  
  The instance table now dedupes by representation identity too: occurrences that share one `IfcMappedItem` / `IfcRepresentationMap` at different orientations collapse to ONE template mesh, verified per occurrence (each occurrence's derived placement must reconstruct that occurrence's own baked vertices within 0.1mm before the group is trusted — if any single occurrence fails, the WHOLE representation group falls back to the previous content-hash behaviour, never a wrong placement). The instance table gains nine `rot0..rot8` columns (row-major 3x3, identity for every non-rotated instance) alongside the existing `origin_x/y/z`: `world = origin + R * template_position`. The optimized-format wire version is 3 for a payload that actually carries a non-identity rotation, and stays 2 otherwise — a response with no rotational reuse is byte-shaped exactly as before (no `rot0..rot8` columns) and keeps decoding on clients that predate this change. Only a genuinely rotation-bearing payload declares 3, where a v2-only decoder must reject it rather than silently ignore the rotation and misplace every rotated instance.
  
  `optimization_stats.unique_meshes`/`mesh_reuse_ratio` now reflect the real dedup, not a separate content-hash-only estimate.

- [#3907](https://github.com/LTplus-AG/ifc-lite/pull/3907) [`4bdab03`](https://github.com/LTplus-AG/ifc-lite/commit/4bdab03efb71f878f307ceb3767beb83d8c8b0f6) Thanks [@louistrue](https://github.com/louistrue)! - Streaming cache hits no longer pay for the upload.
  
  `POST /api/v1/parse/parquet-stream` keys on the SHA-256 of the bytes it
  receives, so the whole file had to arrive before the cache could be consulted.
  On a 40 MB model that upload was the entire cost of a hit. The route now also
  accepts `?sha256={hex}` with no request body: if everything the replay needs is
  already cached it streams it back, and otherwise answers 404 meaning "send the
  file". A hash that arrives alongside a body is ignored, so the received bytes
  still decide which entry is read and written.
  
  `parseParquetStream` in `@ifc-lite/server-client` hashes the file locally and
  probes before uploading. The probe degrades to the upload whenever it is not
  answered, so pointing an upgraded client at a server that predates this change
  still works. This also makes a hit progressive: it used to fetch the
  whole model through `/cache/geometry` and hand it over as one batch. Pass
  `{ skipCacheProbe: true }` to upload straight away.

### Patch Changes

- [#3897](https://github.com/LTplus-AG/ifc-lite/pull/3897) [`e08db2b`](https://github.com/LTplus-AG/ifc-lite/commit/e08db2be8976c1e16a92c6d86d25289547ec05fc) Thanks [@louistrue](https://github.com/louistrue)! - A cache hit on `POST /api/v1/parse/parquet-stream` replayed geometry as a single oversized `batch` event with zero `progress` events, instead of the `Start` / (`batch`, `progress`)* / `Complete` shape a live parse streams ([#3895](https://github.com/LTplus-AG/ifc-lite/issues/3895)). The cached geometry blob still carries its original stream-batch boundaries as Parquet row groups; the replay now recovers them and re-emits one `batch` plus one `progress` event per original batch, byte-identical to what the live path would have sent for that batch. The streaming cache writer now pins one row group per batch (arrow-rs otherwise splits the vertex table past 1,048,576 rows, which large models cross), so the boundaries survive on exactly the models this helps. A blob with no recoverable boundary — a single row group, or a corrupt one — replays as one batch, same as before.

- [#3897](https://github.com/LTplus-AG/ifc-lite/pull/3897) [`e08db2b`](https://github.com/LTplus-AG/ifc-lite/commit/e08db2be8976c1e16a92c6d86d25289547ec05fc) Thanks [@louistrue](https://github.com/louistrue)! - `progress` events on `POST /api/v1/parse/parquet-stream` reported different units on a cache hit than on a miss ([#3897](https://github.com/LTplus-AG/ifc-lite/issues/3897)). A live parse reports the pipeline's geometry JOB counts (`processed_jobs` / `total_jobs`); the cached replay counted the meshes it emitted, and a job can produce several meshes or none, so the same file streamed `0/3, 3/3` when parsed and `0/4, 4/4` when replayed. `start.total_estimate` had the same split. The live path now caches its per-batch job checkpoints beside the geometry and the replay emits those, so a hit and a miss report the same numbers. Entries cached before the sidecar existed have no job counts to replay and keep the old mesh-unit behaviour.

## 1.16.7

### Patch Changes

- [#2650](https://github.com/LTplus-AG/ifc-lite/pull/2650) [`d02fea3`](https://github.com/LTplus-AG/ifc-lite/commit/d02fea3deff6d98b8863adb36bd2aea5f9c9e25f) Thanks [@louistrue](https://github.com/louistrue)! - Fail closed when no SHA-256 checksum is available for a downloaded server binary. The release pipeline now publishes an `<archive>.sha256` sidecar next to every archive, so a missing or unfetchable checksum means the download cannot be verified and is refused instead of executed behind a warning (previously the fail-open branch was the only one that ever ran, because no sidecar was ever published). Releases without sidecars are only ever downloaded by older package versions, which keep their shipped behaviour.

## 1.16.6

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 1.16.5

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 1.16.4

### Patch Changes

- [#1404](https://github.com/LTplus-AG/ifc-lite/pull/1404) [`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC2X3 `ePset_MapConversion` / `ePset_ProjectedCRS` georeferencing so the authored EPSG code is read (not a fallback `EPSG:4326`), and route those models into the Cesium / federation pipeline.

  IFC2X3 has no native `IfcMapConversion`/`IfcProjectedCRS`, so tools like `ifc-georeferencer` store georeferencing in property sets per the buildingSMART guide. Three bugs dropped these models to the legacy `IfcSite` lat/long (`EPSG:4326`), so two files differing only by CRS (`EPSG:7415` RD+NAP vs `EPSG:28992` RD) both displayed the same wrong CRS:

  - The pset-name match was case-sensitive (`ePSet_`/`EPset_`) and missed the real-world `ePset_` casing — now matched case-insensitively in both the TS (`extractGeoreferencing`) and Rust (`GeoRefExtractor`) extractors.
  - The ePSet path never read `ePset_ProjectedCRS.Name` (nor `MapConversion.TargetCRS`), so the EPSG code was discarded — now surfaced, with typed `IFCLABEL(...)`/`IFCLENGTHMEASURE(...)` values unwrapped.
  - The viewer's on-demand extractor never loaded the property sets at all — now pulls in the georef ePSets + their values (only when no `IfcMapConversion` exists, deferred-atom safe).

  The viewer's Cesium/federation gate accepts the `ePSetMapConversion` source, and ePSet offsets are scaled by the project length unit (millimetres for these files) so the model reprojects to the correct location instead of ~1000× out of range. The offline reproject fallback for the compound `EPSG:7415` (datum reported as `RD`) now carries the Kadaster `+towgs84` shift.

## 1.16.3

### Patch Changes

- [#1115](https://github.com/LTplus-AG/ifc-lite/pull/1115) [`65335ad`](https://github.com/LTplus-AG/ifc-lite/commit/65335ad86ec8c72954f49eba0f8feb7144e342fb) Thanks [@louistrue](https://github.com/louistrue)! - Rebuild the prebuilt native server binary to ship the latest Rust geometry/processing changes.

  `@ifc-lite/server-bin` downloads its per-platform native archive from a GitHub release tagged at its own version, and the release workflow skips rebuilding assets when that tag already exists. Bump the patch version so a fresh `v<server-bin>` release fires and the prebuilt binary carries the merged native-side geometry work — the per-element local frame, the deterministic CSG escalation budget (the [#1109](https://github.com/LTplus-AG/ifc-lite/issues/1109) 95% hang fix), the f64 interval-lambda / cmp_along predicate filters, and the curved-wall watertightness guard.

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
