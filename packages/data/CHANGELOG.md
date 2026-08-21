# @ifc-lite/data

## 3.4.0

### Minor Changes

- [#2753](https://github.com/LTplus-AG/ifc-lite/pull/2753) [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2) Thanks [@mpancera](https://github.com/mpancera)! - Index `IfcRelConnectsPortToElement` and `IfcRelConnectsPorts`, so plant topology is traversable.
  
  The ports themselves were always parsed — they are `IfcProduct` subtypes and land in the `EntityTable` like any other product — but neither relationship was in the index, so nothing recorded which element a port belonged to or which port it was joined to. A distribution system therefore read as a set of unrelated parts, and there was no way to answer "what is this pump connected to" from the store.
  
  - `RelationshipType` gains `ConnectsPortToElement = 44` and `ConnectsPorts = 45`, keeping the existing 40-range grouping for connection relationships.
  - Both need their own branch in `extractRelFast`: their two ends are single references at attributes 4 and 5, which neither existing branch reads. The default branch takes attribute 5 as a list, and the `IfcRelConnectsElements` branch skips one attribute first because that entity carries an optional `ConnectionGeometry` ahead of its ends.
  - `IfcRelConnectsPorts.RealizingElement` (the optional element that realises a connection, e.g. a length of duct) is deliberately not read. It is a third party to the connection rather than one of its two ends, and treating it as one would invent an edge between a port and that element.
  
  A plant is walked as element → `ConnectsPortToElement` inverse → its ports → `ConnectsPorts` → the opposite ports → `ConnectsPortToElement` forward → their elements.

### Patch Changes

- [#2904](https://github.com/LTplus-AG/ifc-lite/pull/2904) [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Corrected the `towgs84` Helmert-transform rotation signs for EPSG:31370 (Belgian Lambert 72) and EPSG:3021 (Sweden RT90), and added the missing `towgs84` clause for EPSG:2065 (S-JTSK (Ferro) / Krovak) in the bundled EPSG index. epsg.io's `.proj4` output is not consistent about the Position Vector vs. Coordinate Frame rotation convention, and a rotation triplet published under the wrong convention is syntactically valid but silently mispositions the transform by tens to hundreds of metres.

## 3.3.0

### Minor Changes

- [#2564](https://github.com/LTplus-AG/ifc-lite/pull/2564) [`02079a6`](https://github.com/LTplus-AG/ifc-lite/commit/02079a66042a6e446b9f83f656685f6056020718) Thanks [@louistrue](https://github.com/louistrue)! - One constant for the IFCX header version, exported as `IFCX_VERSION` from `@ifc-lite/data` and re-exported by `@ifc-lite/ifcx`.

  Seven call sites hardcoded this string and they did not agree: six said `ifcx_alpha`, and `@ifc-lite/ifcx`'s own `IfcxWriter` said `IFCX-1.0`. Nothing caught it because `parseIfcx` matches case-insensitively on the substring `ifcx`, so both parse. The same forgiving read is why the Rust exporter could write the version under `header.version` for its entire life while every file it produced was rejected by our own parser ([#2556](https://github.com/LTplus-AG/ifc-lite/issues/2556)).

  **Behaviour change:** `IfcxWriter` / `exportToIfcx` now stamp `ifcx_alpha` instead of `IFCX-1.0`, matching every other writer here and buildingSMART's own reference files. Readers accepting either value are unaffected, and no internal caller was relying on the old string. Layer content addresses are unaffected — the layer paths already wrote `ifcx_alpha`.

## 3.2.4

### Patch Changes

- Updated dependencies [[`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797)]:
  - @ifc-lite/encoding@2.0.0

## 3.2.3

### Patch Changes

- [#2497](https://github.com/LTplus-AG/ifc-lite/pull/2497) [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171) Thanks [@louistrue](https://github.com/louistrue)! - `parseStepValue` decodes ISO 10303-21 backslash directives, and the decoder that does it now lives in one place ([#2490](https://github.com/LTplus-AG/ifc-lite/issues/2490)).

  **What changes for a caller.** `@ifc-lite/data`'s `parseStepValue` un-doubled the two lexical doublings (`''` and `\\`) with a directive-blind pair of regexes and stopped there, so a string literal taken from a real IFC file came back with its directives intact: `'\X2\00FC\X0\'` returned those nine characters where the shared decoder returns `ü`, and `'\X2\00FC\X0\\'` returned `\X2\00FC\X0\` where it should return `ü\`. `\X\HH`, `\S\x` and `\Px\` were equally untouched, and the same gap applied inside a list, since `parseStepList` recurses through the same function. All of those now decode. Values written by this module's own escaper are unaffected — it emits non-ASCII raw and never emits a directive, so every `\\` it produces really is a doubled reverse solidus and the round trip was, and remains, exact. That is why this was invisible from inside the package: the reader was the exact inverse of the writer, and only a literal from somewhere else could tell them apart. `parseStepValue` is a public export, so that is a supported way to reach it.

  **Why the escaper does not move with it.** The pair is still closed. Emitting non-ASCII raw stays valid against the new reader — there are no backslashes to double and nothing to decode — and the directive-precedence rule in the shared scan is what keeps a value that merely LOOKS like a directive round-tripping as literal text: `\X2\00FC\X0\` written out as `\\X2\\00FC\\X0\\` reads back as those characters rather than decoding to `ü`. Switching the writer to emit `\X2\` directives would also round-trip, and is a separate decision about output bytes rather than a correctness fix.

  **One decoder instead of two.** The implementation is now `decodeStepStringLiteral`, exported from `@ifc-lite/encoding` (the additive API, hence the minor there). `packages/parser/src/source-header.ts` had written the same scan privately in [#2486](https://github.com/LTplus-AG/ifc-lite/issues/2486) after its own directive-blind regex corrupted non-ASCII header fields on round trip; that copy is deleted and both readers call the shared one. Its behaviour is unchanged — the code moved verbatim — so header parsing is byte-for-byte what it was. Two independent copies of a decoder this subtle is exactly how the second directive-blind regex survived, and the resolution is genuinely not two passes: a doubling pass run first eats a directive's own terminator whenever an escaped backslash follows it (`\X2\00FC\X0\` + `\\` ends in three backslashes), leaving an unterminated `\X2\` that never decodes.

  **A new dependency edge, `@ifc-lite/data` -> `@ifc-lite/encoding`.** It is acyclic — `@ifc-lite/encoding` has no dependencies of its own and imports nothing from `@ifc-lite/data` — and free in practice: every package that consumes `@ifc-lite/data` (parser, export, sdk, bcf, create, lists) already installs `@ifc-lite/encoding`. Released as a patch for `@ifc-lite/data`: no exported API changes, and the behavioural difference is a decode that was missing.

- Updated dependencies [[`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c), [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/encoding@1.16.0

## 3.2.2

### Patch Changes

- [#2233](https://github.com/LTplus-AG/ifc-lite/pull/2233) [`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `EntityTable.setTypeOverride` storing a UI retype's class name in whatever casing the caller passed instead of canonicalising it.

  A "change class" retype hands `setTypeOverride` a raw UPPERCASE IFC class token (e.g. `IFCBUILDINGSTOREY`), and `getTypeName` echoed the override straight back unchanged. `isSpatialStructureTypeName` — and any other case-sensitive `*Name` predicate built off `IfcTypeEnumToString`'s PascalCase output — matches against the PascalCase form only, so a retyped entity's new class silently stopped being recognised as part of the spatial tree, even though the case-insensitive `isStoreyLikeSpatialTypeName` correctly saw it. `setTypeOverride` now canonicalises the incoming name to PascalCase before storing it, so `getTypeName` and every name-based predicate agree regardless of the casing a caller passes in.

  `EntityTable` has three independent implementations — the columnar table in `@ifc-lite/data`, the cache-restored table in `@ifc-lite/cache`, and the server-backed table in `apps/viewer` — and all three stored the override verbatim. Fixing only one would have left the same retype behaving differently depending on whether the model came from a fresh parse, a cache restore, or the server, which is harder to diagnose than the original bug. All three now canonicalise identically.

- [#2319](https://github.com/LTplus-AG/ifc-lite/pull/2319) [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add the four entities missing from `IFC_ENTITY_NAMES` — `IfcProxy`, `IfcSolidStratum`, `IfcVoidStratum`, `IfcWaterStratum`. All four are representable in `IfcTypeEnum`/`IfcTypeEnumToString`, but were absent from the UPPERCASE→PascalCase table, so any direct `IFC_ENTITY_NAMES[upper] ?? upper` lookup fell through to the raw UPPERCASE STEP keyword instead of the PascalCase name. That affects `@ifc-lite/mcp`'s `query`/`diff`/`validation`/`discovery` tools and `@ifc-lite/cli`'s `info`/`diff` commands whenever a model contains one of these types — and `IFCPROXY` in particular is minted by `schema-converter.ts` itself when downgrading IFC4X3 entities to IFC4, so it is not an exotic case.

  The file's header claimed it was auto-generated and must not be edited by hand, naming `scripts/generate-entity-names.ts` as the way to regenerate it. That script does not exist anywhere in the repository and is referenced nowhere else, so the table is in practice maintained by hand and no regeneration path was available to fix the drift. The header now says so, rather than directing the next maintainer to a command that cannot be run.

  A completeness test (`ifc-entity-names.test.ts`) now pins every `IfcTypeEnum` member with a known PascalCase spelling against `IFC_ENTITY_NAMES`, so future drift — including a regeneration that drops entries again — fails loudly instead of silently degrading display names.

- [#2241](https://github.com/LTplus-AG/ifc-lite/pull/2241) [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095) Thanks [@louistrue](https://github.com/louistrue)! - Cap the `safeUtf8Decode` scratch buffer so an oversized one-off decode no longer retains its full allocation for the lifetime of the realm.

  The scratch grew by doubling to the largest subarray ever decoded and was never released. That is the right trade for the 50-500 byte per-entity reads the helper was written for, but a single whole-source decode pushed it to the next power of two above the file size and kept it there: a 342 MB model pinned 512 MB, measured as 30% of the viewer's main-thread heap ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)).

  Decodes at or under 4 MiB keep the existing reused buffer unchanged. Larger ones now get a throwaway buffer, since reuse only pays off for a buffer that is hit repeatedly and a one-off giant decode never is.

- [#2179](https://github.com/LTplus-AG/ifc-lite/pull/2179) [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop `QuantityTable.sumByType` from silently ignoring its declared `elementType` filter.

  `sumByType(quantityName, elementType?)` declares an optional element-type filter, but two of the three implementations were arity-1 closures that dropped it: the columnar table in `@ifc-lite/data` and the cache-restored table in `@ifc-lite/cache`. The third — the server-backed table in `apps/viewer` — honours it for real, resolving ids through `entities.getByType`. So three implementations of one interface disagreed, and a caller holding the interface type had no way to tell which behaviour it would get.

  The failure mode mattered more than the type-level inaccuracy: a dropped filter returns a total over _every_ element rather than an error, and in a quantity context a plausible wrong number is worse than a loud failure. No caller passes the second argument today, so nothing changes for existing code.

  Neither implementation can honour the filter as written — both see only `entityId` per row, with the entity-type mapping living in `EntityTable`. Rather than leave the contract lying, both now throw when `elementType` is passed, naming the supported route (resolve ids via `entities.getByType(elementType)` and total the matching rows). The interface doc records why.

## 3.2.1

### Patch Changes

- [#2100](https://github.com/LTplus-AG/ifc-lite/pull/2100) [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop four package-level failures from being reported as ordinary results.

  - `@ifc-lite/data` / `@ifc-lite/cache`: a List-typed property with no value
    came back as `[]` — a real empty list — because the NULL string sentinel
    resolved to `''` and the resulting `JSON.parse` throw was swallowed. NULL
    now reads as `null`, matching the string branch beside it, and a genuinely
    unparseable list value logs once (latched) before falling back to `[]`.
  - `@ifc-lite/create`: `extractWallSegmentsForStorey` silently defaulted to a
    metre length-unit scale when unit extraction threw, mis-scaling every
    extracted wall segment on a millimetre model. It now warns with the error,
    matching `resolveSpatialAnchor` / `resolveDuplicateSource`.
  - `@ifc-lite/cli`: `ifc-lite schema` printed a reduced built-in schema as if
    it were the full SDK surface when `@ifc-lite/sandbox/schema` could not be
    loaded; it now says so on stderr and exits non-zero (stdout is still pure
    JSON, unchanged shape), so a piping caller that discards stderr still sees
    the failure. `--version` no longer reports a hard-coded `0.4.0` when
    `package.json` is unreadable — it reports `0.0.0-unknown` and explains why
    on stderr.
  - `@ifc-lite/geometry`: the shard and finalise paths that fall back from a
    SharedArrayBuffer view to a materialised (file-sized) copy now say so once
    per worker, matching the streaming-prepass path that already did.

## 3.2.0

### Minor Changes

- [#2031](https://github.com/LTplus-AG/ifc-lite/pull/2031) [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275) Thanks [@louistrue](https://github.com/louistrue)! - **schema**: `isKnownType` and `normalizeIfcTypeName` now answer for every bundled IFC schema (IFC2X3 + IFC4 + IFC4X3), not just the IFC4_ADD2_TC1 codegen pin (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

  Both read `isKnownEntity` / `getEntityMetadata`, which are generated from the pin and answer "unknown" for any class it does not carry. Measured on the bundled tables: 251 real classes, including 100 `IfcObjectDefinition` ones — the IFC2X3 classes IFC4 dropped (`IfcMove`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcOrderAction`, …) and the IFC4X3 infrastructure classes it never had (`IfcRoad`, `IfcSignal`, `IfcAlignment`, `IfcRailway`, `IfcMarineFacility`, …). `normalizeIfcTypeName` had the same blind spot from the other side: it fell through to "preserve as-is", so `'IFCROAD'` stayed `'IFCROAD'` instead of canonicalizing to `'IfcRoad'`.

  Both now resolve against the schema union first and fall back to the pin, the same order `getInheritanceChainAcrossSchemas` uses.

  `isKnownType` is still a guard, not a pass-through. Typos (`IfcWal`, `IfcRoadd`), vendor extensions, and the 138 EXPRESS _defined types_ the upstream SchemaInfo tables carry as entity rows are all still rejected — 132 named by the cross-schema `IFC_DATA_TYPES` table (`IfcLengthMeasure`, `IfcBoolean`, `IfcCountMeasure`, …) and 6 more that only the pin's own `SCHEMA_REGISTRY.types` map names (`IfcBinary`, `IfcArcIndex`, `IfcLineIndex`, `IfcComplexNumber`, `IfcCompoundPlaneAngleMeasure`, `IfcPropertySetDefinitionSet`). None of the 776 pinned classes appears in either table, so no IFC4 answer changes.

  It answers known-ness, not instantiability: abstract supertypes (`IfcProduct`, `IfcRoot`) are real IFC classes and still answer `true`, exactly as they did before. Rejecting those is a separate, pre-existing question — `main` already accepts 123 of them — tracked in [#2035](https://github.com/LTplus-AG/ifc-lite/issues/2035).

  **data**: exports `IFC_DATA_TYPES`, the raw bundled defined-type table, for the same reason the `ENTITIES_*` tables are exported: a synchronous guard deciding "is this a class I may instantiate?" has to subtract the defined types, and the existing `findDataType` is async.

## 3.1.0

### Minor Changes

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

## 3.0.0

### Major Changes

- [#1864](https://github.com/LTplus-AG/ifc-lite/pull/1864) [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7) Thanks [@louistrue](https://github.com/louistrue)! - Remove `EntityTable.getGlobalIdMap()`.

  It was added alongside `getExpressIdByGlobalId()` for BCF integration and never
  used — the BCF lookup, tier-0 scan, export adapter, embed handler and CLI
  diagnostics all call `getExpressIdByGlobalId()` (point lookups). No caller ever
  needed the materialized map.

  Carrying it had a real cost: every implementation returned
  `new Map(globalIdToExpressId)`, a full defensive copy that would have doubled the
  peak memory of the largest string-keyed structure in the table the moment anyone
  called it, and it froze a `Map` return type into the canonical interface that
  three builders had to keep satisfying in lockstep.

  Migration: use `getExpressIdByGlobalId(globalId)` for GlobalId → expressId, and
  the existing `getGlobalId(expressId)` column accessor for the reverse. Both are
  unchanged.

### Minor Changes

- [#1857](https://github.com/LTplus-AG/ifc-lite/pull/1857) [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f) Thanks [@louistrue](https://github.com/louistrue)! - Add the canonical storey-elevation definitions (`findStoreyByElevation`, `STOREY_ELEVATION_MATCH_TOLERANCE_M`, `IFC_BUILDING_STOREY_ELEVATION_INDEX`, `IFC_BUILDING_STOREY_PLACEMENT_INDEX`) next to the `SpatialHierarchy` interface they implement, so every path resolves a storey from a Z the same way (issue [#1841](https://github.com/LTplus-AG/ifc-lite/issues/1841)).

  `getStoreyByElevation` had four implementations and three of them disagreed with the fourth: `SpatialHierarchyBuilder` returned `null` beyond a 1m band, while the worker-transport rehydration in `@ifc-lite/parser`, the IFCX hierarchy builder, and the viewer's server-loaded path all snapped to the nearest storey unconditionally. The same Z could therefore resolve to a different storey depending on entry path, and even on which side of the worker boundary the store was read. All four now call the shared resolver; behaviour follows the tolerance-bounded rule.

### Patch Changes

- [#1850](https://github.com/LTplus-AG/ifc-lite/pull/1850) [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc) Thanks [@louistrue](https://github.com/louistrue)! - Type-qualify SELECT-typed and IfcValue-family STEP attributes on export. A
  defined-type SELECT member (a boolean in an `IfcTranslationalStiffnessSelect`
  slot, a length in `IfcSizeSelect`) now serializes as the ISO 10303-21 required
  `IFCBOOLEAN(.T.)` / `IFCLENGTHMEASURE(3.)` rather than a bare `.T.` / `3` that
  strict validators reject and that loses the member type on round-trip. The
  exporter auto-qualifies unambiguous slots from the schema registry with no
  caller change; a new write-only `{ typed: { type, value } }` marker on
  `IfcAttributeValue` pins the type for ambiguous selects and the `IfcValue`
  family (`NominalValue`, quantity values) and subsumes `{ real }`. Completes the
  `setPositionalAttribute` / `addEntity` follow-up to [#1839](https://github.com/LTplus-AG/ifc-lite/issues/1839).

## 2.8.0

### Minor Changes

- [#1800](https://github.com/LTplus-AG/ifc-lite/pull/1800) [`3441fb9`](https://github.com/LTplus-AG/ifc-lite/commit/3441fb9e902daea8ed7d6f1a692e75618bbecb7e) Thanks [@louistrue](https://github.com/louistrue)! - Preserve the STEP token kind (Enum vs quoted String) through the columnar parser ([#1799](https://github.com/LTplus-AG/ifc-lite/issues/1799)). `EntityExtractor` now records which top-level attributes were bare enumeration tokens (`.USERDEFINED.`) in a new optional `IfcEntity.enumAttrIndices` side channel — the value representation is unchanged (enums are still stored as dotted strings), so existing consumers are unaffected. `extractRootAttributesFromEntity` rejects enum tokens on the unknown-type fixed-index fallback by token KIND instead of the [#1779](https://github.com/LTplus-AG/ifc-lite/issues/1779) dotted-string shape heuristic: a quoted string that merely looks like an enum (`'.USERDEFINED.'`) now survives, exactly matching the Rust server path's `AttributeValue::String` / `AttributeValue::Enum` split, while a bare `PredefinedType` enum landing on a fallback slot (e.g. IFC4X3 `IfcAlignment` attr 7) is still blanked.

## 2.7.0

### Minor Changes

- [#1769](https://github.com/LTplus-AG/ifc-lite/pull/1769) [`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Demesher: selective per-element mesh simplification with lightweight IFC re-export ([#1767](https://github.com/LTplus-AG/ifc-lite/issues/1767)). `@ifc-lite/export` gains `DemeshSession` — pick elements (usually the heaviest, see `heaviest(n)`), escalate simplification one level per `simplify()` call (levels 1-4 = internal-cavity removal + vertex-clustering decimation at target ratios 0.5/0.25/0.10/0.03, level 5 = bounding-box collapse) with render-ready replacement meshes for live scene updates, then export a lighter IFC separately via `exportIfc()`, which authors `IfcTriangulatedFaceSet` geometry and prunes the replaced representation subgraphs (IFC2X3 input auto-upconverts to IFC4). Also exported: `applySimplifiedGeometry` and the supporting types.

  `@ifc-lite/geometry` gains `GeometryProcessor.simplifyMeshes()` backed by the new wasm `simplifyMeshes` API (`SimplifiedMeshes`). `@ifc-lite/cli` gains `ifc-lite simplify <file.ifc> --level 1..5 [--ids ...] --out light.ifc [--json]` for dev/testing. `@ifc-lite/data` / `@ifc-lite/mutations` widen `IfcAttributeValue` with a write-only `{ real: number }` marker (serialized by `stepReal()` in `@ifc-lite/export`) so tessellation coordinates always carry a decimal point.

- [#1785](https://github.com/LTplus-AG/ifc-lite/pull/1785) [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90) Thanks [@louistrue](https://github.com/louistrue)! - IDS validation on server-parsed models now matches candidate values for multi-valued properties (enumerated / bounded / list / table), for INSTANCE-attached properties, identically to the in-browser path ([#1766](https://github.com/LTplus-AG/ifc-lite/issues/1766)). The server emits the same `values[]` candidate array `parsePropertyValue` produces — enumerated/list members, bounded lower/upper/setPoint (deduped), table defining-then-defined values — as a JSON-encoded nullable `values_json` column (data-model cache v4 → v5, sparse: only multi-value rows). The decoder parses it, `convertServerDataModel`'s `materializeProp` attaches it to the property entry, and the existing IDS bridge (`projectProperty` → facet `candidateValues`) consumes it unchanged, so a facet passes when the constraint matches ANY candidate (not just the joined display value). `@ifc-lite/data`'s `Property` gains an optional `values?: string[]`.

## 2.6.0

### Minor Changes

- [#1778](https://github.com/LTplus-AG/ifc-lite/pull/1778) [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3) Thanks [@louistrue](https://github.com/louistrue)! - Server-parse path now resolves the Lists attribute columns `Description`, `ObjectType`, `PredefinedType`, and `Tag` identically to the in-browser (WASM) path ([#1765](https://github.com/LTplus-AG/ifc-lite/issues/1765)). The server extracts them at the SAME schema-registry positions the WASM path resolves attribute names against — via a Rust index table generated from `@ifc-lite/parser`'s `SCHEMA_REGISTRY` (`scripts/generate-server-attr-indices.mjs`) — so the traps hold on both paths: `IfcSite` attr 7 (LongName) never surfaces as Tag, `IfcWallType` attr 4 (ApplicableOccurrence) never surfaces as ObjectType, and `CompositionType` enums never leak into PredefinedType. Data-model payload bumped to v4 with nullable `description`/`object_type`/`tag`/`predefined_type` entity columns; `@ifc-lite/data`'s `EntityTable` gains optional `getTag`/`getPredefinedType` accessors (server-parsed stores implement them; the WASM path keeps its on-demand source extraction).

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Fix STEP REAL serialization and string-attribute quoting.

  `toStepReal` / `serializePropertyValue` (export) and `serializeValue` (data) appended a bare `.` to JavaScript's exponent notation, emitting invalid ISO-10303-21 literals (`5e-8` -> `5e-8.`, `1e21` -> `1e+21.`) and leaving a nonconforming lowercase `e` (`1.5e-7`). A single shared `formatStepReal` helper now performs the mantissa/`E` rewrite (`5.E-8`, `1.E+21`, `1.5E-7`), and `toStepRealScaled` reuses it.

  `serializeAttributeValue` (export) now always emits a quoted+escaped STEP string when the edited attribute's source token is a quoted string, so user free-text like `[#12](https://github.com/LTplus-AG/ifc-lite/issues/12)`, `$`, `*`, or `.FOO.` can no longer be reinterpreted as an entity reference, null/derived marker, or enum.

### Patch Changes

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Fix deterministic GlobalId first character and STEP header escape round-trip.

  `deterministicGlobalId` masked its first output character with the full 6-bit alphabet, but a valid 22-char IFC GlobalId encodes only 2 bits in its first character (128 = 2 + 21\*6). The id is now stamped from the hash's 128-bit state MSB-first exactly like `uuidToIfcGuid`'s compression, so it always decodes to a well-formed 128-bit UUID and re-encodes bit-exactly. This also fixes a severe entropy loss in the previous stamping: it read each state word's LOW 6 bits while evolving it with a 32-bit multiply (which never propagates high bits downward), leaving ~24 bits of effective entropy and real collisions at ~10k seeds; the full-state stamping is collision-free across 100k adversarial seeds.

  Header string round-trip no longer corrupts ISO-10303-21 escapes: `parseSourceHeader` now decodes `\X2\`, `\X\`, `\S\` and `\Px\` directives to real Unicode (via the canonical `decodeIfcString`) instead of leaving them for the writer's backslash-doubling escaper to mangle (`Tr\X2\00FC\X0\mpler` no longer becomes `Tr\\X2\\00FC\\X0\\mpler`), and collapses the `\\` escape to a single literal backslash first, so `C:\temp` is byte-stable across repeated write/read cycles instead of growing backslashes. The shared STEP string escaper (data) also collapses control characters to a space so a header/attribute value can never inject a physical line break.

## 2.5.3

### Patch Changes

- [#1700](https://github.com/LTplus-AG/ifc-lite/pull/1700) [`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762) Thanks [@louistrue](https://github.com/louistrue)! - Harden the immediate-Container spatial level ([#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591) follow-up):

  - The spatial hierarchy now records an aggregated-descendant containment walk for ANY spatial container node, not just storeys, via a new optional `SpatialHierarchy.elementToContainer` map (also carried across data-store transport). A part nested through an IfcElementAssembly under an IfcBridgePart / IfcRoadPart / IfcSpatialZone now resolves that container instead of a blank cell. Storey-only `elementToStorey` semantics are unchanged.
  - The list engine matches the spatial level string case-insensitively, so a hand-edited / imported list carrying `container` resolves the Container level rather than silently falling back to the storey name. An empty or unrecognised level still defaults to Storey.

## 2.5.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 2.5.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 2.5.0

### Minor Changes

- [#1642](https://github.com/LTplus-AG/ifc-lite/pull/1642) [`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d) Thanks [@louistrue](https://github.com/louistrue)! - Carry a spatial node's IFC `LongName` through the hierarchy so the spatial structure can show both the short code and the descriptive label, e.g. "01" + "Main Residence" (issue [#1634](https://github.com/LTplus-AG/ifc-lite/issues/1634)):

  - `@ifc-lite/data`: `SpatialNode` gains an optional `longName?: string` (the descriptive name, kept only when present and distinct from `name`). Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/parser`: `SpatialHierarchyBuilder` now reads `LongName` off the source record by schema attribute _name_ and populates `SpatialNode.longName`. Resolving by name (not a fixed index) keeps it correct across the IfcRoot family, since `IfcProject` carries `LongName` at a different index than the `IfcSpatialStructureElement` subtypes; the lookup spans the bundled schema union (2X3 + 4 + 4X3) via the new `getAttributeNamesAcrossSchemas`, so IFC4.3 facility/infra containers (`IfcFacility`, `IfcBridge`, `IfcRoad`, …) outside the parser's IFC4 codegen pin resolve too. When `Name` is empty it falls back to `LongName` for the primary label. The source-less `buildFromCache` path leaves it undefined, exactly like storey elevation. `data-store-transport` serializes the new field so the worker→main transfer preserves it.
  - `@ifc-lite/ifcx`: the IFCX/IFC5 hierarchy builder populates `SpatialNode.longName` from `bsi::ifc::prop::LongName` for parity.

## 2.4.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - Plumb the IFC measure type through the property pipeline so consumers can show units (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `@ifc-lite/data`: `Property` gains an optional `dataType?: string` carrying the raw IFC measure value type (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) of a typed nominal value. Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/mutations`: the `PropertyExtractor` function type now carries the same optional `dataType?` per property, and `MutablePropertyView.getForEntity` preserves it through the base and mutation-merge paths, so a property's measure type survives the merge for unit display.
  - `@ifc-lite/mcp`: `geometry_volume` / `geometry_area` now resolve the volume/area symbol from the file's declared `IfcUnitAssignment` (via `@ifc-lite/parser`'s `extractProjectUnits`) instead of hardcoding `m³` / `m²`, and report the resolved symbol in a new `unit` response field. Falls back to the SI default when the store has no source buffer or declares no such unit.

## 2.3.0

### Minor Changes

- [#1503](https://github.com/LTplus-AG/ifc-lite/pull/1503) [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229) Thanks [@louistrue](https://github.com/louistrue)! - fix(query): scope `whereProperty` to the named property set

  `EntityQuery.whereProperty(psetName, propName, ...)` recorded the property-set
  name but never passed it to `findByProperty`, so a property matched in _any_
  property set — e.g. filtering `Pset_WallCommon.IsExternal` also returned doors
  whose `Pset_DoorCommon.IsExternal` matched. `findByProperty` gains an optional
  `psetName` argument (honored by the in-memory, cache-restored, and
  server-converted property tables), and `whereProperty` now passes it. An unknown
  pset name matches nothing.

## 2.2.0

### Minor Changes

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

## 2.1.1

### Patch Changes

- [#1210](https://github.com/LTplus-AG/ifc-lite/pull/1210) [`249761a`](https://github.com/LTplus-AG/ifc-lite/commit/249761ab7f1d51ce46b3058b595a6fad7c26db7e) Thanks [@louistrue](https://github.com/louistrue)! - Accept the IDS `partOf` facet's merged voids/fills relation. The IDS XSD
  enumerates `IFCRELVOIDSELEMENT IFCRELFILLSELEMENT` as a single
  space-separated token (the two relations were merged upstream), but it was
  flagged as an invalid relation on import and silently collapsed to
  voids-only. It is now recognised end-to-end: the parser preserves the
  combined relation, the schema auditor accepts it, and the ancestor walk
  follows both the fills and voids edges so an element reaches its host
  building element through the opening. Fixes [#1205](https://github.com/LTplus-AG/ifc-lite/issues/1205).

## 2.1.0

### Minor Changes

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

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

## 2.0.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

## 2.0.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 2.0.1

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

## 2.0.0

### Major Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

## 1.17.0

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

## 1.16.0

### Minor Changes

- [#623](https://github.com/louistrue/ifc-lite/pull/623) [`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43) Thanks [@louistrue](https://github.com/louistrue)! - Add per-IFC-version schema lookup tables generated from
  buildingSMART/IDS-Audit-tool's `SchemaInfo.*.g.cs` source files (MIT).
  Covers IFC2X3, IFC4 and IFC4X3 (with `IFC4X3_ADD2` aliased to IFC4X3).

  Totals: **2711 entities, 1485 property sets, 7624 properties, 390 IFC
  data types, 2765 attribute rows, 18 partOf relations**.

  New helpers:

  - `getEntities(version)` → entity table (name, parent, abstract,
    predefined types, attributes, source schema, type-entity).
  - `getPropertySets(version)` → pset table (name, applicableEntities,
    properties with `kind` ∈ {single, enumeration, list, bounded,
    reference} + dataType / enumeration values).
  - `getPartOfRelations(version)` → IfcRel\* table (relation, owner,
    member).
  - `getDataTypes(version)` → IFC dataType → backing XSD type
    (e.g. `IFCLABEL → xs:string`, `IFCREAL → xs:double`).
  - `getAttributes(version)` → attribute → simple-value-allowed entities
    vs complex/entity-typed entities.
  - `findEntity` / `findPropertySet` / `findDataType` / `findAttribute`
    for case-insensitive lookups.
  - `getInheritanceChain(version, name)` walks the EXPRESS chain.
  - `isEntitySubtypeOf(version, entity, target)` does subtype tests.
  - `RESERVED_PSET_PREFIXES` constant — `Pset_` and `Qto_`.

  Generator script: `packages/data/scripts/generate-ifc-schema.ts`,
  invokable via `pnpm --filter @ifc-lite/data run generate:ifc-schema`.
  The vendored upstream C# source files and the upstream MIT license live
  in `scripts/upstream/` so the generator can run offline; the README in
  that directory documents the update workflow.

  The async API contract is intentional: even though the seed tables are
  bundled JS modules today, future implementations may dynamically import
  multi-MB JSON dumps without a breaking change.

  This is consumed by `@ifc-lite/ids`'s new `auditIDSDocument`, but the
  helpers are general-purpose — any consumer that needs case-insensitive
  entity/pset lookup, EXPRESS inheritance chains, or subtype tests can
  use them.

## 1.15.2

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Optimize memory usage by adding `CompactEntityIndexBuilder` for streaming entity index construction and `EntityTable.getTypeEnum()` for lightweight type lookups without full attribute extraction.

## 1.15.1

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.15.0

### Minor Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Add a committed full EPSG CRS index with local exact-code lookup and text search helpers.

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

## 1.14.6

### Patch Changes

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Recognize IFC4.3 facility and facility-part spatial containers when building parser hierarchies so infrastructure models render a usable spatial tree.

## 1.14.5

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

## 1.14.4

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

## 1.9.0

## 1.8.0

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

## 1.3.0

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages
