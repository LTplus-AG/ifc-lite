# @ifc-lite/lists

## 1.21.0

### Minor Changes

- [#1801](https://github.com/LTplus-AG/ifc-lite/pull/1801) [`e3378c4`](https://github.com/LTplus-AG/ifc-lite/commit/e3378c4a0dd88fc774801e772be24b2f97aca7f7) Thanks [@louistrue](https://github.com/louistrue)! - Count aggregation with multi-criteria grouping in lists (issue [#1790](https://github.com/LTplus-AG/ifc-lite/issues/1790)): `ListGrouping.columnIds` groups rows by several columns in order (e.g. Building, then Storey); `summariseListRows` emits a flat pre-order group list with `level`/`path` and a per-group `count` (the Count aggregate) plus per-column sums at every nesting level. New helpers: `groupingColumnIds` resolves the effective group columns with full backward compatibility for the legacy single `columnId`, and `groupPathKey` encodes a group path into its collision-free unique key (`ListGroup.key` is now this JSON path encoding).

### Patch Changes

- Updated dependencies [[`3441fb9`](https://github.com/LTplus-AG/ifc-lite/commit/3441fb9e902daea8ed7d6f1a692e75618bbecb7e)]:
  - @ifc-lite/data@2.8.0

## 1.20.1

### Patch Changes

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90)]:
  - @ifc-lite/data@2.7.0

## 1.20.0

### Minor Changes

- [#1759](https://github.com/LTplus-AG/ifc-lite/pull/1759) [`e49a1a0`](https://github.com/LTplus-AG/ifc-lite/commit/e49a1a020eaafd397af626e88a058b69122a1bd9) Thanks [@louistrue](https://github.com/louistrue)! - Server-parse path now resolves Type-level properties/QTOs in Lists/Schedules identically to the in-browser (WASM) path ([#1751](https://github.com/LTplus-AG/ifc-lite/issues/1751)), and adds a `Type` list column showing the element's IfcTypeProduct name ([#1754](https://github.com/LTplus-AG/ifc-lite/issues/1754)).

  Two things were broken on the server path and are fixed together:

  - **Every text/boolean property was garbled.** The server's property extractor only matched bare strings/numbers, so STEP's typed wrappers (`IFCLABEL('X')`, `IFCBOOLEAN(.T.)`) fell through to a Rust `Debug` string typed `"unknown"`. It now mirrors the WASM `parsePropertyValue` — resolving canonical value + kind (`string`/`boolean`/`logical`/`integer`/`real`) and carrying the raw measure tag (`data_type`, e.g. `IFCLENGTHMEASURE`) — so numeric cells sum/sort and unit conversion ([#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)) works. `@ifc-lite/server-client`'s `Property` gains an optional `data_type` (data-model payload bumped to v3).

  - **Type sets never reached the client.** The server dropped `IfcRelDefinesByType` and never read a type's `HasPropertySets`. It now emits the type→element relationship plus a synthetic `TYPEHASPROPERTYSETS` edge per type-owned set, and the viewer merges those onto the type id (own sets first, name-deduped) — matching the WASM path exactly.

  `@ifc-lite/lists` adds a `Type` attribute column and an optional `getEntityDefiningTypeName` accessor on `ListDataProvider`. A cross-path parity test asserts identical `executeList` rows, column metadata, and group sums for the same file through both parse paths.

### Patch Changes

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Harden BCF archive I/O and the CSV formula-injection guard.

  BCF writer now sanitizes a topic GUID before using it as a zip folder name, so a GUID parsed from untrusted markup (`../../evil`) can no longer traverse outside the archive root on a read-modify-save (zip-slip). Sanitized names that collide (`a?b` and `a:b` both map to `a_b`) are disambiguated with a hash of the original GUID plus a counter backstop, so no topic silently overwrites another. BCF reader now caps the compressed input size, the raw zip record count (scanned from the buffer, so duplicate-pathname floods that JSZip dedupes to one visible entry are still counted), and the declared expanded size; because declared sizes are attacker-controlled, the expansion cap is additionally enforced on the ACTUAL decompressed bytes as entries stream out, aborting mid-entry. Entries declaring invalid (negative-reading) sizes are rejected outright.

  The lists CSV export formula-injection guard no longer quotes genuine numeric cells: `-0.35` and `+1` export unquoted (summable in Excel), while real injection vectors (`=`, `@`, tab/CR, and a leading `-`/`+` that is not a plain number such as `-cmd` or `-1+cmd`) are still prefixed with an apostrophe.

- Updated dependencies [[`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7)]:
  - @ifc-lite/data@2.6.0
  - @ifc-lite/encoding@1.14.11

## 1.19.0

### Minor Changes

- [#1748](https://github.com/LTplus-AG/ifc-lite/pull/1748) [`ae6079f`](https://github.com/LTplus-AG/ifc-lite/commit/ae6079f0d2d8a3dbc923dfd468817c7f3e2f9b4a) Thanks [@louistrue](https://github.com/louistrue)! - Lists/Schedules now resolve Type-level properties and quantities on instance rows ([#1745](https://github.com/LTplus-AG/ifc-lite/issues/1745)). A column mapped to a pset/qto that lives on an element's `IfcTypeProduct` (via `IfcRelDefinesByType`) — e.g. `Pset_WallCommon.FireRating` or `Qto_WallBaseQuantities.Width` defined once on `IfcWallType` — now falls back to the type when the instance has no local value, so it no longer renders a blank cell. Instance-level values still take precedence, and the same fallback applies to list filter conditions.

  `@ifc-lite/parser` gains `extractTypeQuantitiesOnDemand` (and the `extractQsetsFromIds` helper) mirroring the existing `extractTypePropertiesOnDemand`. `@ifc-lite/lists` gains optional `getTypePropertySets` / `getTypeQuantitySets` accessors on `ListDataProvider`; providers that don't implement them keep their previous behaviour (no fallback).

## 1.18.4

### Patch Changes

- [#1700](https://github.com/LTplus-AG/ifc-lite/pull/1700) [`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762) Thanks [@louistrue](https://github.com/louistrue)! - Harden the immediate-Container spatial level ([#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591) follow-up):

  - The spatial hierarchy now records an aggregated-descendant containment walk for ANY spatial container node, not just storeys, via a new optional `SpatialHierarchy.elementToContainer` map (also carried across data-store transport). A part nested through an IfcElementAssembly under an IfcBridgePart / IfcRoadPart / IfcSpatialZone now resolves that container instead of a blank cell. Storey-only `elementToStorey` semantics are unchanged.
  - The list engine matches the spatial level string case-insensitively, so a hand-edited / imported list carrying `container` resolves the Container level rather than silently falling back to the storey name. An empty or unrecognised level still defaults to Storey.

- [#1700](https://github.com/LTplus-AG/ifc-lite/pull/1700) [`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762) Thanks [@louistrue](https://github.com/louistrue)! - Add a `Container` spatial level: a `spatial` column or condition with `propertyName: 'Container'` resolves the element's IMMEDIATE spatial container (its direct IfcRelContainedInSpatialStructure parent - the storey, or for infrastructure the IfcBridgePart / IfcRoadPart / IfcSpatialZone it sits in) via the new optional `ListDataProvider.getContainerName`. Providers without the method keep returning blank cells; existing levels (`Storey` default, `Building`, `Site`, `Project`) are unchanged.

- Updated dependencies [[`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762)]:
  - @ifc-lite/data@2.5.3

## 1.18.3

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/encoding@1.14.10

## 1.18.2

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/encoding@1.14.9

## 1.18.1

### Patch Changes

- Updated dependencies [[`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d)]:
  - @ifc-lite/data@2.5.0

## 1.18.0

### Minor Changes

- [#1614](https://github.com/LTplus-AG/ifc-lite/pull/1614) [`f6f8bd2`](https://github.com/LTplus-AG/ifc-lite/commit/f6f8bd2ca0be7b242fb78bef1bd1a1b8a5ab8944) Thanks [@louistrue](https://github.com/louistrue)! - Add federation-identity list columns: a `model` source (source file / model name) and a leveled `spatial` source whose `propertyName` selects `Storey` (default), `Building`, `Site`, or `Project`. Lets a list over several federated models be grouped, sorted, filtered, and exported by which project/site/building/file each row comes from (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)). `ListDataProvider` gains optional `getModelName` / `getProjectName` / `getSiteName` / `getBuildingName` accessors; existing storey-only `spatial` columns keep resolving the storey name.

- [#1626](https://github.com/LTplus-AG/ifc-lite/pull/1626) [`07f630e`](https://github.com/LTplus-AG/ifc-lite/commit/07f630e8373e52f37e5c5133d4b92ca5592368eb) Thanks [@louistrue](https://github.com/louistrue)! - Support Bonsai-style `/regex/` patterns for property-set / quantity-set and property / quantity names. A name wrapped in slashes (e.g. `/Qto_.*BaseQuantities/`, optionally with flags like `/qto_.*/i`) is matched as a regular expression; a plain name stays an exact match. This lets one list column or query read a value across several matching sets at once, for example `NetVolume` from `Qto_WallBaseQuantities` AND `Qto_SlabBaseQuantities` (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)). Applies to `@ifc-lite/lists` column extraction and filter conditions and to the SDK `bim.query().property()` / `quantity()` getters. `@ifc-lite/lists` exports the new `compileNameMatcher` / `isNamePattern` helpers.

## 1.17.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - `ColumnDefinition` gains two optional, execution-time-only fields: `quantityType` (the `QuantityType` a `source: 'quantity'` column resolved to) and `dataType` (the raw IFC measure value type a `source: 'property'` column resolved to, e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`). `executeList` populates them on the RESULT's columns from the first matching entity's quantity/property — the persisted `ListDefinition` authoring schema is never mutated.

  This lets a consumer apply unit-aware display/export logic (the viewer's list export now honours its display-unit converter, issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)) without re-deriving a column's measure type from scratch. Existing consumers are unaffected: both fields are optional and `undefined` unless the caller opts in by reading them.

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/data@2.4.0

## 1.16.1

### Patch Changes

- Updated dependencies [[`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6)]:
  - @ifc-lite/data@2.3.0
  - @ifc-lite/encoding@1.14.8

## 1.16.0

### Minor Changes

- [#1373](https://github.com/LTplus-AG/ifc-lite/pull/1373) [`f8599d7`](https://github.com/LTplus-AG/ifc-lite/commit/f8599d78d7ee040de2bd521c878bae721de774c6) Thanks [@louistrue](https://github.com/louistrue)! - Expose IFC `PredefinedType` as a selectable entity attribute in Lists and Lens. `ENTITY_ATTRIBUTES` (lists) and `ENTITY_ATTRIBUTE_NAMES` (lens) now include `PredefinedType`, so it can be used as a List column / condition and as a Lens "color by attribute" / rule criterion. The list engine resolves it through a new optional `ListDataProvider.getEntityPredefinedType(expressId)` accessor (implementers without it degrade gracefully). ([#1364](https://github.com/LTplus-AG/ifc-lite/issues/1364))

## 1.15.6

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb)]:
  - @ifc-lite/data@2.2.0

## 1.15.5

### Patch Changes

- Updated dependencies [[`249761a`](https://github.com/LTplus-AG/ifc-lite/commit/249761ab7f1d51ce46b3058b595a6fad7c26db7e)]:
  - @ifc-lite/data@2.1.1

## 1.15.4

### Patch Changes

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0

## 1.15.3

### Patch Changes

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe)]:
  - @ifc-lite/data@2.0.3

## 1.15.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7

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
