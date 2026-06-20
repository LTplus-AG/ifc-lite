# @ifc-lite/sdk

## 1.20.1

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722)]:
  - @ifc-lite/export@2.0.0

## 1.20.0

### Minor Changes

- [#1235](https://github.com/LTplus-AG/ifc-lite/pull/1235) [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384) Thanks [@louistrue](https://github.com/louistrue)! - Add HBJSON (Honeybee / Ladybug Tools energy & daylight model) export.

  `ifc-lite export <file.ifc> --format hbjson` and `GeometryProcessor.exportHbjson(buffer, name)`
  produce a Honeybee-valid model: `IfcSpace` volumes become watertight, planar-faced Rooms
  (Floor / RoofCeiling / Wall) ready to load via `Model.from_hbjson` and run in Ladybug Tools /
  Pollination. `IfcWindow` and `IfcDoor` occurrences are placed as coplanar Apertures and Doors
  on the matching exterior walls. Rooms and openings are built analytically from extruded-area
  profiles (not the render mesh), so they are watertight by construction and wasm-safe.
  `IfcRailing` occurrences are emitted as shading `ShadeMesh` geometry, and `IfcMaterialLayerSet`
  build-ups become Honeybee opaque constructions (real layer names + thicknesses; thermal
  properties defaulted by material-name keyword, since IFC rarely carries them) assigned by face
  type. Shared interior walls are paired as `Surface` adjacencies so multi-zone energy models
  don't lose heat to ambient. Backed by a new pure-Rust `ifc-lite-export` crate (source of truth
  for CLI / SDK / wasm). Available in the viewer's export menu as "Export HBJSON (Energy Model)",
  on the CLI as `export --format hbjson`, and via the SDK as `bim.export.hbjson()` (delegated to a
  geometry-capable backend; the data-only SDK stays wasm-free).

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb)]:
  - @ifc-lite/mutations@1.16.0
  - @ifc-lite/export@1.21.0
  - @ifc-lite/data@2.2.0
  - @ifc-lite/ids@1.15.15
  - @ifc-lite/lists@1.15.6

## 1.19.0

### Minor Changes

- [#1152](https://github.com/LTplus-AG/ifc-lite/pull/1152) [`ca8a856`](https://github.com/LTplus-AG/ifc-lite/commit/ca8a856308e5a6df1bb84d0c28f0c1e5059da19a) Thanks [@louistrue](https://github.com/louistrue)! - Add `bim.query.matchingActiveFilter()` — returns the entities matching the host's active advanced filter (or `null` when no filter is set). Backed by a new `QueryBackendMethods.entitiesMatchingActiveFilter()`. Lets scripted exports (e.g. the CSV quantity take-off) honour the current filtered view instead of always exporting the whole model (issue [#1107](https://github.com/LTplus-AG/ifc-lite/issues/1107)).

### Patch Changes

- Updated dependencies [[`61bad47`](https://github.com/LTplus-AG/ifc-lite/commit/61bad47257196b766fb0b8a17c56e53b763ca34a), [`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/mutations@1.15.5
  - @ifc-lite/data@2.1.0
  - @ifc-lite/parser@3.3.0
  - @ifc-lite/export@1.20.0
  - @ifc-lite/lens@1.15.3
  - @ifc-lite/lists@1.15.4
  - @ifc-lite/ids@1.15.12

## 1.18.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/ids@1.15.10
  - @ifc-lite/lists@1.15.3

## 1.18.2

### Patch Changes

- [#1055](https://github.com/LTplus-AG/ifc-lite/pull/1055) [`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): make IDS validation usable on large models with code-list IDS packs.

  Validating a 550k-entity model against an 848-spec IDS document took ~19
  minutes of CPU, produced multi-GB reports, and the CLI then hung forever
  after printing its results. Four root fixes:

  - parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
    in Node an open `MessagePort` holds a libuv handle, so every CLI command
    on a large file kept the process alive after completion. Ports now close
    (helper consolidated into one shared module).
  - ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
    property sets / types / attributes are extracted once per entity instead
    of once per entity _per specification_ (O(specs×entities) source
    re-parses → O(entities)). Enumeration constraints additionally compile
    into exact-match sets (real-world code lists carry 800+ values).
  - ids: per-entity result strings are now bounded — enumeration constraints
    render at most 10 values in failure messages, and the entity-independent
    requirement description is formatted once per requirement instead of per
    entity result (reports for failing models dropped from GBs to MBs).
  - cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
    accessor (the drifted local copy missed type-inherited property sets),
    reports real progress (`spec 312/848 (37%)` instead of
    `undefined (undefined/undefined)`), and skips retaining passing entity
    results for human-readable output (`--json` is unchanged).

  Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
  now come from the validator's per-spec status, which counts
  cardinality-only failures — a `minOccurs="1"` specification that matches
  zero entities now correctly FAILs (exit 1) where it previously passed
  silently. `bim.ids.summarize` likewise prefers the per-spec status when
  the report carries one, so `--json` and text mode agree on the verdict.

  Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
  3.4min→12s, both with a clean exit instead of a hang.

- Updated dependencies [[`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1)]:
  - @ifc-lite/parser@3.1.3
  - @ifc-lite/ids@1.15.8

## 1.18.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc), [`8d5bd67`](https://github.com/LTplus-AG/ifc-lite/commit/8d5bd6701dc9962c2de5e42a7462008b2b8c2885)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/clash@1.1.2
  - @ifc-lite/create@1.16.1
  - @ifc-lite/data@2.0.2
  - @ifc-lite/drawing-2d@1.18.1
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/export@1.19.5
  - @ifc-lite/ids@1.15.6
  - @ifc-lite/lens@1.15.2
  - @ifc-lite/lists@1.15.2
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/spatial@1.14.8

## 1.18.0

### Minor Changes

- [#1022](https://github.com/LTplus-AG/ifc-lite/pull/1022) [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692) Thanks [@louistrue](https://github.com/louistrue)! - feat(spaces): interactive Space Sketch (DCEL) editor + headless generation

  A topology-aware space editor built on a persistent half-edge (DCEL) plate in
  the Rust geometry core, exposed via a stateful `SpacePlateHandle` wasm binding:

  - **Derive** rooms from a storey's walls, **drag** a shared vertex (both rooms
    follow), **split** a room between corners _or_ new nodes added anywhere on a
    wall, **merge** rooms across a shared wall, with undo/redo, and **bake** to
    real `IfcSpace` (via the existing `addSpace` path).
  - **Wall-axis recognition fixes** in `@ifc-lite/create`: read the extractor's
    reliable entity type instead of the columnar table's `'Unknown'` sentinel
    (every `Curve2D` Axis polyline — e.g. all of AC20-FZK-Haus — was skipped), and
    a body-footprint fallback (face sets, `IfcFacetedBrep`, vertically-extruded
    rect / arbitrary / IndexedPolyCurve profiles) for walls without an Axis.
  - Viewer "Space Sketch" tool: storey list with resolved names, auto-derive on
    selection, auto-escalating + manual snap tolerance to close centreline corner
    gaps.
  - **Headless generation** — derive IfcSpace across storeys from the CLI
    (`ifc-lite generate-spaces`), the SDK (`bim.spaces.generate`), or as a library
    function (`generateSpaces` from `@ifc-lite/create`), with auto-escalating snap,
    storey-datum ("slab") floor-to-floor heights, and rectangular corner cleanup
    ported into the TS detector.
  - **Production-grade baked spaces** — every derived `IfcSpace` now carries
    `Qto_SpaceBaseQuantities` (GrossFloorArea / NetFloorArea / GrossPerimeter /
    Height / GrossVolume, schema-aware) and an `IfcRelSpaceBoundary` per bounding
    wall. Generated spaces are stamped with `ObjectType 'IfcLite:GeneratedSpace'`,
    and a re-run skips a model that already contains them (idempotent; `--force`
    to override).

### Patch Changes

- Updated dependencies [[`cef9989`](https://github.com/LTplus-AG/ifc-lite/commit/cef99897ee287029c6db6bbaafcd2a35508af1be), [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692)]:
  - @ifc-lite/create@1.16.0

## 1.17.1

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/drawing-2d@1.16.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/data@2.0.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/lists@1.15.1
  - @ifc-lite/spatial@1.14.7
  - @ifc-lite/lens@1.15.1
  - @ifc-lite/ids@1.15.5

## 1.17.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8)]:
  - @ifc-lite/clash@1.1.0

## 1.16.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/data@2.0.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/query@1.14.8
  - @ifc-lite/drawing-2d@1.16.1
  - @ifc-lite/spatial@1.14.6
  - @ifc-lite/lists@1.14.13
  - @ifc-lite/mutations@1.15.1

## 1.16.0

### Minor Changes

- [#759](https://github.com/LTplus-AG/ifc-lite/pull/759) [`d356a46`](https://github.com/LTplus-AG/ifc-lite/commit/d356a46c632d36c361250c891f8054de655bdd11) Thanks [@louistrue](https://github.com/louistrue)! - Publish the bSDD namespace and the IDS/performance work that landed in the SDK
  since 1.15.0 but was never released.

  The published `@ifc-lite/sdk@1.15.0` build predates three source changes
  ([#607](https://github.com/LTplus-AG/ifc-lite/issues/607) hot-path memoization, [#615](https://github.com/LTplus-AG/ifc-lite/issues/615) the bSDD namespace, [#623](https://github.com/LTplus-AG/ifc-lite/issues/623) IDS document auditing
  and schema validation) because none of those PRs included a changeset bumping
  `@ifc-lite/sdk`. As a result the registry build is missing the `BsddNamespace`
  and `BsddHttpError` exports.

  `@ifc-lite/mcp` imports `BsddHttpError` from `@ifc-lite/sdk`, so a fresh
  `npx @ifc-lite/cli` (which depends on `@ifc-lite/mcp`) crashed at module load
  with `does not provide an export named 'BsddHttpError'`. Releasing `@ifc-lite/sdk@1.16.0`
  makes the existing `^1.15.0` ranges in the already-published `@ifc-lite/mcp` and
  `@ifc-lite/cli` resolve to a build that has the export — no republish of those
  two packages is required.

### Patch Changes

- Updated dependencies [[`58e2e9e`](https://github.com/LTplus-AG/ifc-lite/commit/58e2e9ed3e3f17b6d2fc73ae320ec95be5b17e36)]:
  - @ifc-lite/export@1.18.1

## 1.15.0

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

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — diagnostics, broader wall coverage, and a sweep of
  review feedback.

  **Auto Spaces detection.** The "no enclosed regions detected"
  failure mode now surfaces actionable counts — both in devtools
  and in the panel itself.

  - `extract-walls.ts` now tries the standard `Axis` representation
    (`IfcShapeRepresentation` with `RepresentationIdentifier='Axis'`,
    `IfcPolyline` items) **before** falling back to the
    `addWallToStore` rectangle-profile convention. That covers
    walls authored by Revit / ArchiCAD / IfcOpenShell — the previous
    extractor only handled walls placed via the Add Element tool.
    The placement chain is read once and the polyline endpoints are
    transformed through it, so rotated walls work.
  - Every wall that gets dropped is recorded with a typed reason
    (`no-axis-or-rect-profile`, `placement-not-resolvable`,
    `zero-length-axis`, …) — the panel summarises them as
    `"3× no-axis-or-rect-profile, 1× zero-length-axis"`.
  - `detectEnclosedAreas` exposes a
    `detectEnclosedAreasWithStats(...)` companion that returns
    per-stage counts (vertices, edges-after-split, faces total,
    outer / below-min-area drops, largest area). The intersection
    splitter's iteration cap now scales with input size
    (`max(100, segments * 10)`) so dense floor plans don't bail
    out early.
  - `generateSpacesFromWalls` always logs a `console.info`
    one-liner and threads a new `debug?: boolean` flag down to the
    extractor + detector for verbose tracing. The viewer's Auto
    Spaces panel exposes a "Verbose console logging" checkbox.
  - The Auto Spaces diagnostic block now shows the graph stats
    (`123v / 456e / 78f`), the drop counts, and per-reason wall
    skips. Two amber hints fire automatically when walls were
    extracted but no faces formed (likely snap tolerance), or
    when nothing extracted (likely an unsupported geometry shape).

  **Review-feedback sweep (PR #598).**

  - `addElementMeshes.linearBox()` and the SVG `linearBoxCorners`
    helper honour each endpoint's Y so a sloped beam previews as
    a sloped prism instead of being flattened to the start.
  - `bridge-store.requireStoreyId` rejects `0` (EXPRESS ids are
    1-based, `#0` is never valid).
  - `addWindow` / `addDoor` `tsParamTypes` include
    `UserDefinedPartitioningType` / `UserDefinedOperationType`
    so typed sandbox callers can hit the IFC4 round-trip without
    casts.
  - `AnnotationLayer.resolveEntityType` no longer falls back to
    `ifcDataStore` when the annotation's `modelId` is missing
    from a federated `models` map (would resolve the wrong
    entity in multi-model sessions). Single-model sessions keep
    the fallback.
  - `addDoorToStore` / `addWindowToStore` validate
    `OperationType` / `PartitioningType` against the IFC4 enum
    and re-route unknown values through
    `.USERDEFINED.` + `User-defined…Type` so custom labels
    round-trip cleanly.
  - `addWallToStore` defaults `PredefinedType` to `.NOTDEFINED.`
    (was `.STANDARD.`) to match the rest of the in-store
    builders.
  - `duplicateInStore` / `resolveDuplicateSource` allow
    `OwnerHistory` to be `null` (IFC4 made it optional). The
    duplicate emits a bare `$` token instead of `#null` for the
    omitted case.
  - `StoreEditor.addEntity` accepts an injected schema-aware
    normalizer (`setEntityTypeNormalizer`); `@ifc-lite/sdk`
    registers `normalizeIfcTypeName` + `isKnownType` at load
    time so direct callers — CLI scripts, sandbox bridge,
    unit tests — see registry-grade rejection of typos like
    `IfcWal`, plus canonical PascalCase on `EntityRef.type`.

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c)]:
  - @ifc-lite/create@1.15.0
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/query@1.14.7
  - @ifc-lite/export@1.18.0

## 1.14.6

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/bcf@1.15.2
  - @ifc-lite/create@1.14.5
  - @ifc-lite/data@1.15.1
  - @ifc-lite/drawing-2d@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/export@1.17.2
  - @ifc-lite/ids@1.14.9
  - @ifc-lite/lens@1.14.4
  - @ifc-lite/lists@1.14.9
  - @ifc-lite/mutations@1.14.5
  - @ifc-lite/parser@2.1.6
  - @ifc-lite/query@1.14.6
  - @ifc-lite/spatial@1.14.5

## 1.14.5

### Patch Changes

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

## 1.14.4

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0
  - @ifc-lite/export@1.14.4
  - @ifc-lite/query@1.14.4

## 1.14.3

### Patch Changes

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Align sandbox typings with runtime defaults and fail explicitly when `bim.sandbox` is used from transport-backed contexts.

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Add `addIfcGableRoof`, `addIfcWallDoor`, and `addIfcWallWindow` to the creation API and expose them through the sandbox bridge.

  Add richer IFC-aware query access in the sandbox for selection, containment, spatial paths, storeys, and single property/quantity lookups.

  Harden geometry generation guidance and validation so scripts use the correct roof and wall-hosted opening helpers, and improve prompt context around hierarchy, selection, and storey structure for multi-level generation.

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Fix sandbox creator/session isolation, sandbox lifecycle races, and geometry crash recovery messaging.

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Expose uploaded chat attachments to sandbox scripts through `bim.files.*`, teach the LLM prompt to reuse those files instead of `fetch()`, and add first-class root attribute mutation support for script/export workflows.

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/create@1.14.3
  - @ifc-lite/export@1.14.3
  - @ifc-lite/bcf@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/drawing-2d@1.14.3
  - @ifc-lite/encoding@1.14.3
  - @ifc-lite/ids@1.14.3
  - @ifc-lite/lens@1.14.3
  - @ifc-lite/lists@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/query@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3), [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/export@1.14.2
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/bcf@1.14.2
  - @ifc-lite/create@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/drawing-2d@1.14.2
  - @ifc-lite/encoding@1.14.2
  - @ifc-lite/ids@1.14.2
  - @ifc-lite/lens@1.14.2
  - @ifc-lite/lists@1.14.2
  - @ifc-lite/mutations@1.14.2
  - @ifc-lite/query@1.14.2
  - @ifc-lite/spatial@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/bcf@1.14.1
  - @ifc-lite/create@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/drawing-2d@1.14.1
  - @ifc-lite/encoding@1.14.1
  - @ifc-lite/export@1.14.1
  - @ifc-lite/ids@1.14.1
  - @ifc-lite/lens@1.14.1
  - @ifc-lite/lists@1.14.1
  - @ifc-lite/mutations@1.14.1
  - @ifc-lite/query@1.14.1

## 1.14.0

### Minor Changes

- [#274](https://github.com/louistrue/ifc-lite/pull/274) [`060eced`](https://github.com/louistrue/ifc-lite/commit/060eced467e67f249822ce0303686083a2d9199c) Thanks [@louistrue](https://github.com/louistrue)! - Rename all public API methods to IFC EXPRESS names (`addWall` → `addIfcWall`, `addStorey` → `addIfcBuildingStorey`, etc.), fix STEP serialisation bugs (exponent notation, `IfcQuantityCount` trailing dot, `FILE_DESCRIPTION` double parentheses), add safety guards (`toIfc()` finalize-once, stair riser validation, `vecNorm` zero-length throw, `trackElement` missing-storey throw), and harden SDK create namespace (`download()` throws on missing backend, PascalCase params in `building()` helper).

### Patch Changes

- [#241](https://github.com/louistrue/ifc-lite/pull/241) [`7b81970`](https://github.com/louistrue/ifc-lite/commit/7b81970ea12ba0416651315963c7c6db924657a3) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC STEP export support to the SDK (`bim.export.ifc`) for IFC2X3, IFC4, and IFC4X3 models, including backend contract updates for local viewer integrations.

- Updated dependencies [[`060eced`](https://github.com/louistrue/ifc-lite/commit/060eced467e67f249822ce0303686083a2d9199c)]:
  - @ifc-lite/create@1.14.0
  - @ifc-lite/bcf@1.14.0
  - @ifc-lite/data@1.14.0
  - @ifc-lite/drawing-2d@1.14.0
  - @ifc-lite/encoding@1.14.0
  - @ifc-lite/export@1.14.0
  - @ifc-lite/ids@1.14.0
  - @ifc-lite/lens@1.14.0
  - @ifc-lite/lists@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/query@1.14.0
  - @ifc-lite/spatial@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.13.0
  - @ifc-lite/data@1.13.0
  - @ifc-lite/drawing-2d@1.13.0
  - @ifc-lite/encoding@1.13.0
  - @ifc-lite/export@1.13.0
  - @ifc-lite/ids@1.13.0
  - @ifc-lite/lens@1.13.0
  - @ifc-lite/lists@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/query@1.13.0
  - @ifc-lite/spatial@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [[`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7)]:
  - @ifc-lite/export@1.12.0
  - @ifc-lite/bcf@1.12.0
  - @ifc-lite/data@1.12.0
  - @ifc-lite/drawing-2d@1.12.0
  - @ifc-lite/encoding@1.12.0
  - @ifc-lite/ids@1.12.0
  - @ifc-lite/lens@1.12.0
  - @ifc-lite/lists@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/query@1.12.0
  - @ifc-lite/spatial@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.3
  - @ifc-lite/data@1.11.3
  - @ifc-lite/drawing-2d@1.11.3
  - @ifc-lite/encoding@1.11.3
  - @ifc-lite/export@1.11.3
  - @ifc-lite/ids@1.11.3
  - @ifc-lite/lens@1.11.3
  - @ifc-lite/lists@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/query@1.11.3
  - @ifc-lite/spatial@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/drawing-2d@1.11.1
  - @ifc-lite/encoding@1.11.1
  - @ifc-lite/export@1.11.1
  - @ifc-lite/ids@1.11.1
  - @ifc-lite/lens@1.11.1
  - @ifc-lite/lists@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/query@1.11.1
  - @ifc-lite/spatial@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.0
  - @ifc-lite/data@1.11.0
  - @ifc-lite/drawing-2d@1.11.0
  - @ifc-lite/encoding@1.11.0
  - @ifc-lite/export@1.11.0
  - @ifc-lite/ids@1.11.0
  - @ifc-lite/lens@1.11.0
  - @ifc-lite/lists@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/query@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/ids@1.10.0
  - @ifc-lite/lists@1.10.0
  - @ifc-lite/bcf@1.10.0
  - @ifc-lite/drawing-2d@1.10.0
  - @ifc-lite/encoding@1.10.0
  - @ifc-lite/export@1.10.0
  - @ifc-lite/lens@1.10.0
  - @ifc-lite/mutations@1.10.0
  - @ifc-lite/query@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Minor Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Add scripting platform with sandboxed TypeScript execution and full BIM SDK.

  New packages:

  - `@ifc-lite/sandbox` — sandboxed script runner that transpiles and executes user TypeScript in a Web Worker with BIM globals (`bim.query`, `bim.select`, `bim.viewer`, etc.) isolated from the host page.
  - `@ifc-lite/sdk` — BIM SDK defining the full host↔sandbox message protocol and all namespaces: `query`, `mutate`, `viewer`, `spatial`, `export`, `lens`, `bcf`, `ids`, `drawing`, `list`, `events`.

  New viewer features:

  - **Command Palette** — `Cmd/Ctrl+K` fuzzy-search launcher for viewer actions and scripts.
  - **Script Panel** — full-screen code editor (CodeMirror) with run/stop controls, output log, and CSV download.
  - **6 built-in script templates** — quantity takeoff, fire-safety check, MEP equipment schedule, envelope check, space validation, federation compare.
  - **Recent files** — persisted list of previously opened IFC files.

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix scripting CSV exports missing property and quantity data.

  - `@ifc-lite/sdk` export namespace now resolves quantity-set dot-paths (`Qto_WallBaseQuantities.NetVolume`) in addition to property-set paths, so quantity columns are no longer empty in exports.
  - All 6 built-in script templates (quantity takeoff, fire-safety check, MEP schedule, envelope check, space validation, data-quality audit) updated to dynamically discover and include relevant property/quantity columns instead of hardcoding minimal attribute lists.

- Updated dependencies []:
  - @ifc-lite/bcf@1.9.0
  - @ifc-lite/data@1.9.0
  - @ifc-lite/drawing-2d@1.9.0
  - @ifc-lite/encoding@1.9.0
  - @ifc-lite/export@1.9.0
  - @ifc-lite/ids@1.9.0
  - @ifc-lite/lens@1.9.0
  - @ifc-lite/lists@1.9.0
  - @ifc-lite/mutations@1.9.0
  - @ifc-lite/parser@1.9.0
  - @ifc-lite/query@1.9.0
  - @ifc-lite/spatial@1.9.0
