# @ifc-lite/cli

## 0.7.0

### Minor Changes

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

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC scheduling entity support across the scripting SDK, LLM assistant, and
  CLI headless backend.

  **Create API** — `IfcCreator` gains `addIfcWorkSchedule`, `addIfcWorkPlan`,
  `addIfcTask` (with inline `IfcTaskTime`), `addIfcRelSequence` (with
  `IfcLagTime`), `assignTasksToWorkSchedule` (`IfcRelAssignsToControl`),
  `assignProductsToTask` (`IfcRelAssignsToProcess`), and `nestTasks`
  (`IfcRelNests`).

  **SDK** — new `bim.schedule` read namespace (`data()`, `tasks()`,
  `workSchedules()`, `sequences()`) backed by the parser's
  `extractScheduleOnDemand`. New `ScheduleBackendMethods` is now part of
  `BimBackend`; the viewer's `LocalBackend`, the `RemoteBackend` proxy, and the
  CLI `HeadlessBackend` all implement it.

  **Sandbox** — new `bim.schedule.*` QuickJS namespace plus schedule methods on
  `bim.create.*`, all carrying LLM semantic contracts so the auto-generated
  system prompt teaches the assistant when to use them. Autocomplete types
  (`bim-globals.d.ts`) regenerated.

### Patch Changes

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04), [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/create@1.15.0
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/sdk@1.15.0
  - @ifc-lite/sandbox@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/query@1.14.7
  - @ifc-lite/wasm@1.16.7
  - @ifc-lite/export@1.18.0

## 0.6.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4), [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/wasm@1.16.1
  - @ifc-lite/bcf@1.15.2
  - @ifc-lite/create@1.14.5
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/export@1.17.2
  - @ifc-lite/ids@1.14.9
  - @ifc-lite/mutations@1.14.5
  - @ifc-lite/parser@2.1.6
  - @ifc-lite/query@1.14.6
  - @ifc-lite/sandbox@1.14.5
  - @ifc-lite/sdk@1.14.6
  - @ifc-lite/viewer-core@0.2.3

## 0.6.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/export@1.17.1
  - @ifc-lite/parser@2.1.5
  - @ifc-lite/query@1.14.5
  - @ifc-lite/encoding@1.14.5
  - @ifc-lite/bcf@1.15.1
  - @ifc-lite/mutations@1.14.4
  - @ifc-lite/ids@1.14.8

## 0.6.0

### Minor Changes

- [#388](https://github.com/louistrue/ifc-lite/pull/388) [`30e4f04`](https://github.com/louistrue/ifc-lite/commit/30e4f048dba5e615f44d3d358cdec56dfc83eb14) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D viewer package and CLI `view`/`analyze` commands for interactive browser-based model visualization with REST API

### Patch Changes

- [#382](https://github.com/louistrue/ifc-lite/pull/382) [`55a8227`](https://github.com/louistrue/ifc-lite/commit/55a82272390ae9b89d90f121c984c24fe9bd8a73) Thanks [@louistrue](https://github.com/louistrue)! - Fix GlobalId uniqueness validation to only check entity types that inherit from IfcRoot, using the schema registry dynamically instead of scanning all entities

- Updated dependencies [[`30e4f04`](https://github.com/louistrue/ifc-lite/commit/30e4f048dba5e615f44d3d358cdec56dfc83eb14)]:
  - @ifc-lite/viewer-core@0.2.0

## 0.5.1

### Patch Changes

- [#380](https://github.com/louistrue/ifc-lite/pull/380) [`7fb3572`](https://github.com/louistrue/ifc-lite/commit/7fb3572fe3d3eb8076fca19e26a324c66bd819de) Thanks [@louistrue](https://github.com/louistrue)! - Fix 10 bugs from v0.5.0 test report

  **@ifc-lite/cli:**

  - fix(eval): `--type` and `--limit` flags no longer parsed as part of the expression
  - fix(mutate): support multiple `--set` flags and entity attribute mutation (`--set Name=TestWall`)
  - fix(mutate): restrict ObjectType writes to entities that actually define that attribute
  - fix(ask): exterior wall recipe falls back to all walls with caveat when IsExternal property is missing
  - fix(ask): WWR calculation uses exterior wall area per ISO 13790, falls back only when IsExternal data is truly missing
  - fix(ask): generic count recipe matches any type name (`how many piles` → IfcPile)
  - fix(ask): add largest/smallest element ranking recipes
  - fix(stats): add IfcPile and IfcRamp to element breakdown
  - fix(query): warn when group-by aggregation yields all zeros (missing quantity data)

  **@ifc-lite/create:**

  - fix: generate unique GlobalIds using crypto-strong randomness (Web Crypto API) with per-instance deduplication

- Updated dependencies [[`7fb3572`](https://github.com/louistrue/ifc-lite/commit/7fb3572fe3d3eb8076fca19e26a324c66bd819de)]:
  - @ifc-lite/create@1.14.4

## 0.5.0

### Minor Changes

- [#376](https://github.com/louistrue/ifc-lite/pull/376) [`7d3843b`](https://github.com/louistrue/ifc-lite/commit/7d3843b3e94e2d6e24863cc387469df722d48428) Thanks [@louistrue](https://github.com/louistrue)! - Comprehensive CLI bug fixes and new features:

  **Bug fixes:**

  - `--version` now reads from package.json (was hardcoded "0.2.0")
  - `eval --type`/`--limit` flags no longer concatenated into expression string
  - `--where` filter now searches both property sets and quantity sets for numeric filtering
  - `export --storey` properly filters entities by storey (was silently ignored)
  - Quantities available as export columns (e.g. `--columns Name,GrossSideArea`)
  - `--unique material`, `--unique storey`, `--unique type` now supported
  - `--avg`, `--min`, `--max` aggregation flags produce actual computed results
  - `eval --json` wraps output in a JSON envelope
  - `--type Wall` auto-prefixes to `IfcWall` with a note
  - `--sum` with non-existent quantity shows helpful error and suggestions
  - `--group-by` validates keys and errors on invalid options
  - `--limit` with `--group-by` now limits groups, not entities

  **New features:**

  - `stats` command: one-command building KPIs and health check (exterior wall area, GFA, material volumes)
  - `mutate` command: modify properties via CLI with `--set` and `--out`
  - `ask` command: natural language BIM queries with 15+ built-in recipes
  - `--sort`/`--desc` flags for sorting query results by quantity values
  - `--group-by` now works with `--avg`, `--min`, `--max` (not just `--sum`)

## 0.4.0

### Minor Changes

- [#374](https://github.com/louistrue/ifc-lite/pull/374) [`e20157b`](https://github.com/louistrue/ifc-lite/commit/e20157bd8c0a61e3ec99ea8bae963fba4862517c) Thanks [@louistrue](https://github.com/louistrue)! - ### CLI

  **Bug fixes:**

  - `export --where` now filters entities (was silently ignored)
  - `--group-by storey` resolves actual storey names via spatial containment instead of showing "(no storey)"

  **New flags:**

  - `--property-names`: discover available properties per entity type (parallel to `--quantity-names`)
  - `--unique PsetName.PropName`: show distinct values and counts for a property
  - `--group-by` + `--sum` combo: aggregate quantity per group (e.g. `--group-by material --sum GrossVolume`)

  **UX improvements:**

  - `info` command splits entity types into "Building elements" and "Other types" sections

  ### SDK

  - `bim.quantity(ref, name)` 2-arg shorthand now searches all quantity sets (previously required 3-arg form with explicit qset name)

### Patch Changes

- Updated dependencies [[`e20157b`](https://github.com/louistrue/ifc-lite/commit/e20157bd8c0a61e3ec99ea8bae963fba4862517c)]:
  - @ifc-lite/sdk@1.14.5

## 0.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4
  - @ifc-lite/parser@2.1.2
  - @ifc-lite/ids@1.14.5

## 0.2.0

### Minor Changes

- [#364](https://github.com/louistrue/ifc-lite/pull/364) [`385a3a6`](https://github.com/louistrue/ifc-lite/commit/385a3a62f71f379e13a2de0c3e6c9c4208b9de14) Thanks [@louistrue](https://github.com/louistrue)! - Add @ifc-lite/cli — BIM toolkit for the terminal. Query, validate, export, create, and script IFC files from the command line. Designed for both humans and LLM terminals (Claude Code, Cursor, etc.). Includes headless BimBackend, 10 commands (info, query, props, export, ids, bcf, create, eval, run, schema), JSON output mode, and pipe-friendly design.

### Patch Changes

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/parser@2.1.1
  - @ifc-lite/export@1.15.1
