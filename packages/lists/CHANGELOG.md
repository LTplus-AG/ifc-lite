# @ifc-lite/lists

## 1.15.1

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
  - @ifc-lite/data@2.0.1

## 1.15.0

### Minor Changes

- [#933](https://github.com/LTplus-AG/ifc-lite/pull/933) [`34df1e2`](https://github.com/LTplus-AG/ifc-lite/commit/34df1e2573523e88b8a808b129d71d78057c14a6) Thanks [@louistrue](https://github.com/louistrue)! - Add material, classification, and storey list columns ([#922](https://github.com/LTplus-AG/ifc-lite/issues/922)).

  `ColumnDefinition.source` gains `material` | `classification` | `spatial`
  (storey). The engine resolves them via the optional `ListDataProvider`
  material/classification/storey accessors; material and classification cells
  are de-duplicated and joined.

- [#935](https://github.com/LTplus-AG/ifc-lite/pull/935) [`398c59c`](https://github.com/LTplus-AG/ifc-lite/commit/398c59c942462dd38bea963247741ab298eae857) Thanks [@louistrue](https://github.com/louistrue)! - Add `ListDefinition.expressIdsByModel` — an explicit element-snapshot scope
  keyed by model.

  When set, `executeList` targets exactly the express IDs captured for the
  current model (so a federated list never over-selects when local express IDs
  collide across files), with `conditions` still applied on top and
  `entityTypes` ignored. Lets a search/filter result be frozen into a list
  ([#917](https://github.com/LTplus-AG/ifc-lite/issues/917) §4).

- [#934](https://github.com/LTplus-AG/ifc-lite/pull/934) [`7bb46cd`](https://github.com/LTplus-AG/ifc-lite/commit/7bb46cd265cc93cd2cddc268591d8ee93a2a556b) Thanks [@louistrue](https://github.com/louistrue)! - Add `ListDataProvider.discoverAllColumns()` for complete, type-independent
  column discovery.

  Lets the list column picker offer every property set / property and quantity
  set / quantity in the model — even when no entity type is selected — instead
  of only the columns sampled from the selected types. Optional method; callers
  fall back to the type-sampled `discoverColumns()` when it's absent.

- [#934](https://github.com/LTplus-AG/ifc-lite/pull/934) [`7bb46cd`](https://github.com/LTplus-AG/ifc-lite/commit/7bb46cd265cc93cd2cddc268591d8ee93a2a556b) Thanks [@louistrue](https://github.com/louistrue)! - Add counts, sums, and grouping to list results ([#926](https://github.com/LTplus-AG/ifc-lite/issues/926)).

  `ListDefinition.grouping` ({ columnId, sumColumnIds }) makes `executeList`
  return a per-group breakdown (`ListResult.groups` — label, element count,
  per-column sums) plus a whole-result `summary` (count + sums). Group by any
  column (type, material, classification, storey, property value) and total
  numeric columns per group and overall.

  Also exports `summariseListRows(definition, rows)` so federated callers can
  re-derive groups/summary after merging rows from several models.

- [#932](https://github.com/LTplus-AG/ifc-lite/pull/932) [`3f697e8`](https://github.com/LTplus-AG/ifc-lite/commit/3f697e8818ee8da9dd45403bc00835ed421d94ca) Thanks [@louistrue](https://github.com/louistrue)! - Lists can now target elements beyond IFC class ([#925](https://github.com/LTplus-AG/ifc-lite/issues/925)).

  - `ListDefinition` with an empty `entityTypes` targets all model elements
    (resolved via the new optional `ListDataProvider.getAllEntityIds()`).
  - `PropertyCondition.source` gains `material` | `classification` | `spatial`
    (storey), backed by optional provider accessors `getMaterialNames`,
    `getClassifications`, and `getStoreyName`.

  All new provider methods are optional, so existing `ListDataProvider`
  implementers keep working unchanged.

## 1.14.13

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/data@2.0.0

## 1.14.12

### Patch Changes

- Updated dependencies [[`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/data@1.17.0

## 1.14.11

### Patch Changes

- Updated dependencies [[`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43)]:
  - @ifc-lite/data@1.16.0

## 1.14.10

### Patch Changes

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/data@1.15.2

## 1.14.9

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6

## 1.14.8

### Patch Changes

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/encoding@1.14.5

## 1.14.7

### Patch Changes

- Updated dependencies [[`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9)]:
  - @ifc-lite/data@1.14.6

## 1.14.6

### Patch Changes

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/data@1.14.5

## 1.14.5

### Patch Changes

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4

## 1.14.4

### Patch Changes

- Updated dependencies [[`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87)]:
  - @ifc-lite/encoding@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.3
  - @ifc-lite/encoding@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/encoding@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.1
  - @ifc-lite/encoding@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/encoding@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/encoding@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/encoding@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/encoding@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/encoding@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/encoding@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/encoding@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/encoding@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/encoding@1.8.0

## 1.7.0

### Minor Changes

- [#196](https://github.com/louistrue/ifc-lite/pull/196) [`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658) Thanks [@louistrue](https://github.com/louistrue)! - Add @ifc-lite/encoding and @ifc-lite/lists packages

  - `@ifc-lite/encoding`: IFC string decoding and property value parsing (zero dependencies)
  - `@ifc-lite/lists`: Configurable property list engine with column discovery, presets, and CSV export
  - Both packages expose headless APIs via `ListDataProvider` interface for framework-agnostic usage
  - Viewer updated to consume these packages via `createListDataProvider()` adapter

### Patch Changes

- [#202](https://github.com/louistrue/ifc-lite/pull/202) [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c) Thanks [@louistrue](https://github.com/louistrue)! - Fix empty Description, ObjectType, and Tag columns in lists and show all IFC attributes in property panel

  - Lists: add on-demand attribute extraction fallback with per-provider caching for Description, ObjectType, and Tag columns that were previously always empty
  - Property panel: show ALL string/enum IFC attributes dynamically using the schema registry (Name, Description, ObjectType, Tag, PredefinedType, etc.) instead of hardcoding only Name/Description/ObjectType
  - Parser: add `extractAllEntityAttributes()` for schema-aware full attribute extraction, extend `extractEntityAttributesOnDemand()` to include Tag (IfcElement index 7)
  - Query: add `EntityNode.tag` getter and `EntityNode.allAttributes()` method for comprehensive attribute access
  - Performance: cache `getAttributeNames()` inheritance walks, hoist module-level constants
  - Fix type name casing bug where multi-word UPPERCASE STEP types (e.g., IFCWALLSTANDARDCASE) failed schema lookup

- Updated dependencies [[`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/encoding@1.7.0
  - @ifc-lite/data@1.7.0
