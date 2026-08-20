# @ifc-lite/lens

## 1.18.1

### Patch Changes

- [#2787](https://github.com/LTplus-AG/ifc-lite/pull/2787) [`4f01d5c`](https://github.com/LTplus-AG/ifc-lite/commit/4f01d5caf469c380c5e1a15d807a5ebb7f6de86e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Pin `matchesClassification`'s `systemMatch && codeMatch` (`packages/lens/src/matching.ts:392`) with a truth table.
  
  Test-only; no production code changed. The only existing test supplying both
  `classificationSystem` and `classificationCode` (`'should match classification
  by system AND code'`) gives a case where both match, which passes under `&&`
  and under `||` alike — mutating the `&&` to `||` left all 165 tests green.
  Three cases now cover the remaining rows: system matches but code does not,
  code matches but system does not, and neither matches — each asserting
  `false`, discriminating AND from OR.
  
  Checked the sibling multi-field predicates in the same file
  (`matchesProperty`, `matchesAttribute`, `matchesQuantity`, `matchesMaterial`)
  for the same shape. None share it: each requires only one criteria field to be
  present for its match logic (a `propertySet`/`propertyName` pair, a
  `quantitySet`/`quantityName` pair, etc. are precondition guards, not two
  independently-testable match outcomes ANDed together) — `matchesClassification`
  is the only predicate here where two independently optional fields are both
  matched and ANDed.
  
  Not fixed here, flagged for the maintainer: the `exists` operator's
  empty-string handling is inconsistent across `matchesProperty` (`''` counts as
  present), `matchesQuantity` (`''` counts as present), and `matchesAttribute`
  (`''` counts as absent) — documented in code comments as intentional but not
  exercised by any test. Whether that asymmetry is intended is the maintainer's
  call; a prior sweep judged it low severity and did not pursue it.

## 1.18.0

### Minor Changes

- [#2533](https://github.com/LTplus-AG/ifc-lite/pull/2533) [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Lens criteria gain the comparison operators `ne`, `gt`, `gte`, `lt` and `lte`,
  so numeric conditions such as "Volume > 10" or "Thickness < 200" are
  expressible. Previously `operator` was limited to `equals | contains | exists`,
  which left the `quantity` criteria type - the one that reads a genuinely numeric
  value - able to test only equality.

  The new operators are honoured by the `property`, `attribute` and `quantity`
  criteria types. The remaining types (`ifcType`, `material`, `classification`,
  `model`, `group`) match by identity or substring and ignore `operator`, exactly
  as they did before.

  Comparison semantics are ported from the viewer's search rule model so a lens
  condition and the equivalent search rule agree: `gt`/`gte`/`lt`/`lte` parse both
  sides with `Number.parseFloat` and match only when both parse to a finite
  number, so a numeric comparison against a non-numeric or non-finite value fails
  closed rather than matching via `NaN`; `ne` is a case-insensitive string
  comparison, matching the search layer's `ne` (it is NOT the exact complement of
  `equals`, which stays case-sensitive except for the boolean literal tolerance).
  A missing value never satisfies any of the five.

  `operator` remains optional and the three existing values are unchanged, so
  existing lenses and the shipped presets behave identically.

  Adds the `LensOperator` type and the `LENS_OPERATORS` constant to the public
  surface so a rule editor can enumerate the operators.

- [#2533](https://github.com/LTplus-AG/ifc-lite/pull/2533) [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Compound conditions for lens rules: a rule's criteria can now be `type: "and"` / `type: "or"` with a `conditions` array of member criteria, each a leaf (any of the eight existing criteria types, including the numeric operators) or another nested compound - enough to express Smart-Views-style rules like "IfcWall AND (FireRating >= 60 OR LoadBearing = true)".

  Semantics fail closed: an empty or missing `conditions` array matches nothing (for both operators), a member whose data is absent fails its own leaf (an `or` can still match on another member), and nesting beyond the exported `MAX_COMPOUND_DEPTH` (16) matches nothing. A compound with a single member behaves identically to that member as a plain criteria.

  The change is additive: every existing rule shape evaluates exactly as before, presets are untouched, and an older build of the engine treats a compound rule as inert (it matches nothing) rather than silently matching something else. Also exports `LENS_COMPOUND_TYPES` (`['and', 'or']`) for rule editors; the viewer's lens panel does not yet author a compound rule, but it does surface one: an imported compound displays a read-only "AND - N conditions" summary, its criteria-type selector is disabled instead of letting an edit silently rewrite it into an unrelated leaf, and it is no longer dropped on save.

### Patch Changes

- [#2329](https://github.com/LTplus-AG/ifc-lite/pull/2329) [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `hexToRgba` silently producing a `NaN` color channel for the 3-digit CSS shorthand hex form (`#fff`, `#e53`) and other malformed input (empty string, non-hex characters, wrong length), and fix it separately turning some malformed input into a _plausible-looking wrong color_ instead of a fallback. `hex` is not always a native `<input type="color">` value: it also arrives from imported lens JSON — which type-checks `rule.color` as a string but does not validate its hex _format_ — and from the SDK's `bim.viewer.colorize()` / `colorizeAll()`, published entry points that pass a caller-supplied string straight through. The previous fallback still parsed each channel with `parseInt` before checking for `NaN`, and `parseInt` salvages whatever hex-looking prefix it finds rather than rejecting the whole string — so `hexToRgba('red', 1)` returned a non-zero green channel (`parseInt('d', 16)` is `13`; the blue channel was already `NaN`), and `hexToRgba('[#1234567](https://github.com/LTplus-AG/ifc-lite/issues/1234567)', 1)` silently read the first six digits and dropped the seventh instead of being rejected as the wrong length. `hexToRgba` now expands the 3-digit shorthand, then validates the whole string as exactly six hex digits _before_ parsing, and falls back to `[0, 0, 0, alpha]` for anything that fails that check — never a partially-parsed, partially-garbage color. This is a fallback, not a throw: it stays consistent with the published SDK entry point and the unvalidated JSON import path, where a throw would crash the caller over one bad color instead of degrading a single element's appearance. Well-formed 3-digit and 6-digit input is unaffected. The strict length check also caught a valid CSS form on its way in: `#RRGGBBAA` (8-digit hex with alpha) worked on `main` because the previous per-channel `substring` read R/G/B and ignored the trailing alpha pair, but would have fallen back to black under the new exactly-six-digit check. `hexToRgba` now recognizes the 8-digit form and reads its leading six digits the same way `main` did — `alpha` is still supplied by the second argument, so the trailing `AA` pair is ignored either way. The input is also trimmed before validation, so surrounding whitespace (e.g. `'#E53935 '` from a hand-edited JSON file) no longer falls back to black.

## 1.17.3

### Patch Changes

- [#1960](https://github.com/LTplus-AG/ifc-lite/pull/1960) [`72b896b`](https://github.com/LTplus-AG/ifc-lite/commit/72b896b27eed3f394c76d602a2d1b2eb8db82e2f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the classification "System" picker on auto-color lenses being a no-op. `selectClassificationRef` fell back to an entity's first classification whenever none of its classifications matched the selected system, so every classified entity was grouped and colored regardless of which system was chosen. It now returns no match (the entity ghosts, like an unclassified one) when the selected system isn't among the entity's classifications, actually filtering by system as the picker implies. Closes [#1923](https://github.com/LTplus-AG/ifc-lite/issues/1923).

## 1.17.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 1.17.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 1.17.0

### Minor Changes

- [#1469](https://github.com/LTplus-AG/ifc-lite/pull/1469) [`731579f`](https://github.com/LTplus-AG/ifc-lite/commit/731579f6a981b5e55e36b8ff949dc5a51003ec08) Thanks [@louistrue](https://github.com/louistrue)! - Classification auto-color legends now show the human-readable name alongside the
  system and code ([#1460](https://github.com/LTplus-AG/ifc-lite/issues/1460)). An entry reads e.g. `Uniclass: EF_25_10 (Walls)` instead
  of just `Uniclass: EF_25_10`. Grouping is unchanged - it still keys off
  `System: Code`, so the same code never fragments across slightly different names;
  the name is purely a label, taken from the first reference seen for that code, and
  the parenthetical is dropped when the name merely repeats the code.

## 1.16.1

### Patch Changes

- [#1412](https://github.com/LTplus-AG/ifc-lite/pull/1412) [`8c56b98`](https://github.com/LTplus-AG/ifc-lite/commit/8c56b985e0e5a6839c407f9eb5844831b3bdb711) Thanks [@louistrue](https://github.com/louistrue)! - Lens `equals` matching now compares boolean values case-insensitively. IFC booleans surface in the properties panel capitalized (`True` / `False`), but `String(boolean)` is lowercase, so a rule typed as the value the user sees never matched. Non-boolean strings stay case-sensitive so codes and ratings keep matching exactly. ([#1403](https://github.com/LTplus-AG/ifc-lite/issues/1403))

## 1.16.0

### Minor Changes

- [#1373](https://github.com/LTplus-AG/ifc-lite/pull/1373) [`f8599d7`](https://github.com/LTplus-AG/ifc-lite/commit/f8599d78d7ee040de2bd521c878bae721de774c6) Thanks [@louistrue](https://github.com/louistrue)! - Expose IFC `PredefinedType` as a selectable entity attribute in Lists and Lens. `ENTITY_ATTRIBUTES` (lists) and `ENTITY_ATTRIBUTE_NAMES` (lens) now include `PredefinedType`, so it can be used as a List column / condition and as a Lens "color by attribute" / rule criterion. The list engine resolves it through a new optional `ListDataProvider.getEntityPredefinedType(expressId)` accessor (implementers without it degrade gracefully). ([#1364](https://github.com/LTplus-AG/ifc-lite/issues/1364))

- [#1374](https://github.com/LTplus-AG/ifc-lite/pull/1374) [`35a3fd7`](https://github.com/LTplus-AG/ifc-lite/commit/35a3fd786519080524b037a8990908ae880bdef8) Thanks [@louistrue](https://github.com/louistrue)! - "Color/select by Material" now groups by individual materials instead of the layer-set / usage name. A multi-layer element (e.g. a wall of gypsum board + insulation) now belongs to each of its materials' groups, so selecting "gypsum board" isolates every wall containing it — including multi-layer walls — and the legend lists the real materials rather than the Revit family/type string. Material rule criteria (`materialName`) match the same way. Adds an optional `LensDataProvider.getMaterialNames(globalId)` accessor; providers without it fall back to the previous single `getMaterialName` value. ([#1366](https://github.com/LTplus-AG/ifc-lite/issues/1366))

## 1.15.3

### Patch Changes

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

## 1.15.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

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

## 1.15.0

### Minor Changes

- [#823](https://github.com/LTplus-AG/ifc-lite/pull/823) [`a72c8d9`](https://github.com/LTplus-AG/ifc-lite/commit/a72c8d9d71da428cec6453e60c650c6cb296007c) Thanks [@jonatanjacobsson](https://github.com/jonatanjacobsson)! - Add `model` criteria type and auto-color source for federated model coloring, including a built-in "By Model" preset.

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

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

### Minor Changes

- [#205](https://github.com/louistrue/ifc-lite/pull/205) [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81) Thanks [@louistrue](https://github.com/louistrue)! - Add flexible lens coloring system with GPU overlay rendering

  - Color overlay system: renders lens colors on top of original geometry using depth-equal pipeline, eliminating batch rebuild and framerate drops
  - Auto-color by any IFC data: properties, quantities, classifications, materials, attributes, and class
  - Dynamic discovery of available data from loaded models (lazy on-demand for properties, quantities, classifications, materials)
  - Classification system selector in AutoColorEditor (separates Uniclass/OmniClass)
  - Unlimited unique colors with sortable legend

## 1.7.0
