# @ifc-lite/query

## 1.14.16

### Patch Changes

- [#2218](https://github.com/LTplus-AG/ifc-lite/pull/2218) [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix three `EntityNode` relationship helpers that traversed the graph in the wrong direction.

  The parser builds every edge as `addEdge(relatingObject, relatedObject)` (`columnar-parser.ts:476`), so `forward` always means relating → related. Three helpers were oriented against that:

  - `filledBy()` used `inverse`. `IfcRelFillsElement` is `(RelatingOpeningElement, RelatedBuildingElement)`, so the opening is the source and the filler the target — reaching the filler from the opening is a forward traversal. As written the method returned an empty array for every opening, which is indistinguishable from "this opening has no filler".
  - `definingType()` used `forward` and `instances()` used `inverse`. `IfcRelDefinesByType` has the type as its relating object, so the type is the source and each occurrence the target; both helpers were the wrong way round. The element → type lookups in `on-demand-extractors.ts` already used `inverse` for this, so the two disagreed.

  `filledBy()` is the one with an observable consequence today: `@ifc-lite/clash` calls `opening.filledBy()` to exclude a host element from clashing with the door or window filling its own opening (`adapters/step.ts:172`). Because the call always returned nothing, that exclusion never fired and every door and window could report a false-positive clash against the opening it legitimately fills. `definingType()` and `instances()` have no in-repo callers, so their fix is latent — but they are public API.

  The gap survived because the unit-test fixture encoded the reverse orientation for `IfcRelDefinesByType`, so the mock and the reversed code agreed with each other. The fixture is corrected to match the parser, and `IfcRelFillsElement` — previously absent from it entirely — is now covered.

- [#2321](https://github.com/LTplus-AG/ifc-lite/pull/2321) [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `EntityQuery.first()` permanently capping the query it was called on. `first()` narrowed the result set by calling `this.limit(1)` — which mutates the query object itself rather than a clone — so the cap outlived the call: every subsequent `execute()`, `ids()` or `first()` on the same query returned at most one row. A caller's own explicit `limit(n)` was overwritten too, silently collapsing to 1.

  Building a query, peeking at the first match, then iterating it in full is ordinary usage of a fluent query API, and `EntityQuery` is published surface — so "no in-repo caller does that" is not a defence here, the same reasoning applied to `ParquetExporter`'s un-memoised overlay index in the [#2111](https://github.com/LTplus-AG/ifc-lite/issues/2111) review.

  `first()` now narrows for the duration of the call only, restoring whatever limit was previously set rather than clearing it.

- Updated dependencies [[`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da)]:
  - @ifc-lite/data@3.2.2
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/geometry@3.7.1

## 1.14.15

### Patch Changes

- [#1935](https://github.com/LTplus-AG/ifc-lite/pull/1935) [`9a7b5a2`](https://github.com/LTplus-AG/ifc-lite/commit/9a7b5a2fc1bb85ce60e954ccf7819829e43431d6) Thanks [@louistrue](https://github.com/louistrue)! - fix(query): make `whereProperty` actually filter STEP-parsed models

  `EntityQuery.whereProperty()` returned `[]` for every `.ifc` (STEP) model, for
  any property-set name, silently — no error, no warning. `applyPropertyFilters`
  only consulted `store.properties.findByProperty`, but a STEP parse deliberately
  leaves the columnar property/quantity tables empty and routes reads through the
  on-demand maps (issue [#577](https://github.com/LTplus-AG/ifc-lite/issues/577)), so that lookup could only ever return nothing. The
  read path (`EntityNode.property`, `QueryResultEntity.getProperty`) resolved the
  same data correctly, so a model that plainly carried the property still filtered
  to nothing. [#577](https://github.com/LTplus-AG/ifc-lite/issues/577) / [#578](https://github.com/LTplus-AG/ifc-lite/issues/578) fixed this class on the read path and left the filter
  path behind; this is that other half.

  `whereProperty` now picks a strategy per store. When the property table reports
  an explicit zero row count it resolves the surviving candidates through
  `store.getProperties` / `store.getQuantities`, the same accessors the read path
  uses; otherwise it answers off the table's name indices as before. Only an
  explicit zero selects the fallback — a duck-typed store whose table omits the
  optional `count` keeps the indexed path, because every store written before
  `count` existed implements `findByProperty` for real. The fallback is
  candidate-scoped, and each entity is resolved at most once _per source_ across
  all filters: property sets and quantity sets have separate caches, so an entity
  reached by both sides costs one `getProperties` and one `getQuantities`, never
  one per filter.
  Nothing is materialised onto `store.properties`, so IDS keeps reading the richer
  on-demand property shape.

  Quantity sets are folded into the same call on every store, making the
  documented `whereProperty('Qto_WallBaseQuantities', 'NetSideArea', '>', 10)`
  form work; previously a `Qto_` filter matched nothing on any path.

  Matching is ANY-match: an entity passes when any property of that name, in any
  set of that name, satisfies the operator. That is what
  `PropertyTable.findByProperty` already did, so the two strategies agree with
  each other. It deliberately differs from the single-value read path, which
  returns the first match — the two disagree only for an entity carrying the same
  property twice, and that divergence is pinned by a test.

  `@ifc-lite/data` gains two additive optional interface members and one new
  export: `QuantityTable.findByQuantity` (the quantity mirror of `findByProperty`,
  answered off the quantity-name index), `count` on `IfcStoreBase`'s property and
  quantity tables, and `comparePropertyValues` — the definition of property-filter
  comparison semantics shared by the store-level property tables (same-type only,
  `null` never matches, `==` aliases `=`). `@ifc-lite/cache` and the viewer's
  server-converted store now use
  `comparePropertyValues` instead of local copies: the cache copy had no boolean
  branch, so a cache-restored `findByProperty('IsExternal', '=', true)` silently
  returned `[]`, and the server copy ignored the operator entirely and compared
  with `===`, so `'>' 60` answered `= 60`.

  **Cost.** Filtering a STEP model is now real work where it used to be an instant
  wrong answer. The shape of that work: the filter resolves property sets **per
  candidate**, so cost is proportional to how many entities reach the filter, not
  to how many carry the property. Scope with `ofType(...)` / `onStorey(...)` before
  `whereProperty(...)` — an unscoped `query.all().whereProperty(...)` resolves
  every entity in the model. The guide and the package README now say so.

  This per-candidate path covers more than a fresh `.ifc` parse. A cache written
  from a STEP parse serialises the empty property table verbatim, so a
  cache-restored `.ifc` model reports `count === 0` and takes the same fallback;
  the viewer's server-converted store reports `count: 0` too. What decides the
  path is the store rather than the file format: a store carrying table rows is
  answered from the index, and one reporting no rows resolves per candidate.

  Those indexed stores are deliberately kept off the per-candidate path: folding
  quantities by resolving every candidate would have made a `Qto_` filter cost
  them per candidate as well, so the quantity side goes through the new
  `findByQuantity` name index instead. Where an indexed store's cost moves at all
  it is because the query is answered rather than silently returning nothing — a
  `Qto_` filter that used to match zero entities now matches the real set.

- Updated dependencies [[`9a7b5a2`](https://github.com/LTplus-AG/ifc-lite/commit/9a7b5a2fc1bb85ce60e954ccf7819829e43431d6)]:
  - @ifc-lite/data@3.1.0

## 1.14.14

### Patch Changes

- Updated dependencies [[`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/data@3.0.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/geometry@3.5.0

## 1.14.13

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/spatial@1.14.12

## 1.14.12

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/spatial@1.14.11

## 1.14.11

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
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/spatial@1.14.10

## 1.14.10

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/spatial@1.14.8

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/data@2.0.1
  - @ifc-lite/spatial@1.14.7

## 1.14.8

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/spatial@1.14.6

## 1.14.7

### Patch Changes

- [#578](https://github.com/louistrue/ifc-lite/pull/578) [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04) Thanks [@louistrue](https://github.com/louistrue)! - Surface on-demand properties and quantities through the query API.

  `parseColumnar` intentionally leaves the pre-parsed `store.properties` / `store.quantities` tables empty and populates `onDemandPropertyMap` / `onDemandQuantityMap` instead, but `QueryResultEntity` only read from the empty pre-parsed tables. As a result `query.ofType(...).includeProperties().includeQuantities().execute()` always returned elements with empty `properties` / `quantities`, even when the IFC file contained them (issue #577).

  `loadPropertiesFromStore` / `loadQuantitiesFromStore` in `query-result-entity.ts` now fall back to `extractPropertiesOnDemand` / `extractQuantitiesOnDemand` when the pre-parsed tables are empty and the on-demand maps are present. This applies to the `properties` / `quantities` getters, the `loadProperties` / `loadQuantities` eager loaders, and the `getProperty()` accessor.

  Also normalizes untagged STEP enumeration tokens (`.T.` / `.F.` / `.U.` / `.X.`) emitted by some authoring tools in the `NominalValue` slot of `IfcPropertySingleValue`: `.T.` / `.F.` now decode to real JS booleans and `.U.` / `.X.` to a Logical `null`, matching the behavior of the conformant `IFCBOOLEAN(...)` / `IFCLOGICAL(...)` typed form.

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04)]:
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/geometry@1.16.6

## 1.14.6

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/geometry@1.16.2
  - @ifc-lite/parser@2.1.6
  - @ifc-lite/spatial@1.14.5

## 1.14.5

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/geometry@1.16.1
  - @ifc-lite/parser@2.1.5

## 1.14.4

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/spatial@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/data@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/spatial@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/spatial@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/spatial@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/spatial@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/spatial@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/parser@1.9.0
  - @ifc-lite/spatial@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/parser@1.8.0
  - @ifc-lite/spatial@1.8.0

## 1.7.0

### Patch Changes

- [#202](https://github.com/louistrue/ifc-lite/pull/202) [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c) Thanks [@louistrue](https://github.com/louistrue)! - Fix empty Description, ObjectType, and Tag columns in lists and show all IFC attributes in property panel

  - Lists: add on-demand attribute extraction fallback with per-provider caching for Description, ObjectType, and Tag columns that were previously always empty
  - Property panel: show ALL string/enum IFC attributes dynamically using the schema registry (Name, Description, ObjectType, Tag, PredefinedType, etc.) instead of hardcoding only Name/Description/ObjectType
  - Parser: add `extractAllEntityAttributes()` for schema-aware full attribute extraction, extend `extractEntityAttributesOnDemand()` to include Tag (IfcElement index 7)
  - Query: add `EntityNode.tag` getter and `EntityNode.allAttributes()` method for comprehensive attribute access
  - Performance: cache `getAttributeNames()` inheritance walks, hoist module-level constants
  - Fix type name casing bug where multi-word UPPERCASE STEP types (e.g., IFCWALLSTANDARDCASE) failed schema lookup

- Updated dependencies [[`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/data@1.7.0
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/spatial@1.7.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages
