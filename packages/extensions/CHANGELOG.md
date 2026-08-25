# @ifc-lite/extensions

## 0.5.0

### Minor Changes

- [#2957](https://github.com/LTplus-AG/ifc-lite/pull/2957) [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Don't fail a flavor operation on an active-flavor pointer write that changes
  nothing, and snapshot a same-version reinstall before overwriting its bundle.
  
  Four sites wrote in two steps, and treated a refused second write as fatal
  without first asking whether that write would have stored what was stored
  already:
  
  - **`switchFlavor`** rolled every extension toggle back and reported
    `'<pointer>'` when `setActiveFlavor` was refused. Re-applying the flavor that
    is already active writes the id the pointer already holds, so the refusal
    changed nothing — and the rollback disabled every extension the target
    declares. `FlavorSwitcherCallbacks` gains an optional `readActiveFlavor()`;
    when it reports the id `activeFlavorPointer(target)` would have written, the
    switch stands. Without the callback, or when the read fails, the refusal is
    still fatal — the behaviour every host had before.
  - **`activeFlavorPointer(target)`** is now exported: it builds the id the
    pointer stores for a flavor, so the value compared is the value written by
    construction rather than a second derivation that can drift.
  - **`activeFlavorPointerAlreadyStored(read, pointer)`** is now exported and is
    the single comparison both hosts ask through, so a change to how the pointer
    is encoded lands once. It answers `false` for a pointer that is not a string,
    so an absent id can never match an unset pointer and report a refused write
    with nothing stored as a successful one.
  - **`ExtensionHostService.switchFlavor`** (viewer) wires that callback through
    `FlavorService.activeId()`, also new. It turned a failed switch into a thrown
    error, which skipped the lens, clash and sidebar restores below it.
  - **`FlavorService.resetToDefaults`** (viewer) threw when `setActiveId` was
    refused even though the baseline flavor had landed and the pointer already
    named it — the common case, since resetting is the way back from anything.
    It now rethrows only when the pointer is not provably already that id.
  
  Separately, **`installFromBytes`** (viewer) snapshotted the previous install's
  bundle bytes only when the incoming version differed. Bundle bytes are keyed by
  id and version, so a reinstall of the same version overwrote them; a loader
  rejection then deleted the record and the bundle with nothing to restore,
  wiping a working extension. The snapshot is now taken for any previous install.
  The teardown stays gated on a version change.
  
  The rollback also restores the previous record under its own guard, independent
  of the bundle bytes. The record carries the capability grants, the enabled bit,
  the install time and the source, none of which need bytes and none of which the
  user can reconstruct, so a previous install whose bytes were already gone no
  longer has its record deleted by the rollback, and a byte write that fails
  during the restore — `putBundle` is the step with a storage-quota path — no
  longer takes the record down with it. A record without its bytes is a state the
  loader names (`invalid_reference`); reinstalling the same version repairs it and
  keeps the grants, but the app offers no route to that today — the Repair queue
  passes an extension whose engine range still matches, so it never reports the
  missing bytes. Keeping the record is still the better outcome: unloaded *and*
  deleted is strictly worse than unloaded.
  
  The rollback now also checks that the record in storage is still the one this
  install wrote before undoing anything. `load` is an await point, so a user can
  uninstall while a slow load is in flight; restoring the previous record after
  that would undo an explicit uninstall. The check is on record identity, never
  on whether bytes exist, so it does not reintroduce the gate above.
  
  One cost, in the safe direction: because the snapshot is no longer gated on a
  version change, a transient failure reading the previous bundle bytes now fails
  a same-version reinstall that previously would have proceeded. Nothing is
  written or destroyed in that case; the install has to be retried.
  
  Each comparison is one-directional: `false` means "not provably a no-op", never
  a guess, so anything unreadable costs only a refusal that was already the old
  behaviour. No path reports success while the stored state differs from what a
  successful operation would have left.

- [#3026](https://github.com/LTplus-AG/ifc-lite/pull/3026) [`b59c520`](https://github.com/LTplus-AG/ifc-lite/commit/b59c5206a154728139d1307bf823e5c5d7c4786a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `revalidateAgainstSdk` silently treating an unverifiable extension as fine after an SDK bump.
  
  An extension whose declared `engines.ifcLiteSdk` range is too loose to evaluate (e.g. a wildcard like `2.x`) gets `compatibility.status: 'permissive'` — the range comparator's own docs describe this as "worth a re-test, even if the range technically passes." When such an extension has no declared tests (or its bundle bytes aren't available), the test run comes back `outcome: 'skipped'` — nothing actually confirmed it still works. `needsRepair` only included skipped rows whose status was `'outdated'`, so a permissive, self-unverifiable extension never surfaced in the repair queue after a major SDK bump. Since `'skipped'` can only occur for `'outdated'` or `'permissive'` rows (the `'compatible'` branch always resolves to `'pass'` without touching the test runner), `needsRepair` now includes every skipped row.
  
  The rule now lives in one exported function, `needsSdkRepair`. The viewer's repair panel carried a second copy of the predicate to decide which rows get a Repair button, so widening only the queue side made the header ("N need fixing") count permissive, skipped extensions whose rows offered no way to fix them. Both sides call the shared function, and a rendering test pins the invariant the two copies were supposed to preserve: the header count equals the number of rows with a Repair button.

### Patch Changes

- [#3027](https://github.com/LTplus-AG/ifc-lite/pull/3027) [`447f02e`](https://github.com/LTplus-AG/ifc-lite/commit/447f02eefc2933c63c03aea6c7793343df20fcd7) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Bound the AST walks over extension-author source so a deeply nested script is
  reported, not fatal.
  
  `validateCode` and `inferCapabilities` both fed an AST parsed from
  author-supplied source to `acorn-walk`'s `walk.simple`, which recurses once per
  AST level. A script nested a few hundred levels deep threw
  `RangeError: Maximum call stack size exceeded` out of the middle of both
  functions, escaping the result shape each one is declared to return. Measured
  here, an 800-level script overflowed and a 700-level one did not, and which of
  the two overflowed moved with test ordering — the failure point tracked whatever
  stack the caller happened to have left.
  
  Both now traverse through a new internal `walkBounded`
  (`src/ast/bounded-walk.ts`), which keeps its own stack on the heap and stops at
  `MAX_AST_DEPTH = 1000` (~500 source levels of `if (1) { … }`; acorn's own parser
  gives up somewhere above that, but where depends on the host's remaining stack —
  measured on Node 22 between 1100 and 4000 source levels, so it is not a fixed
  floor to sit under). It descends using `acorn-walk`'s `base` visitor
  and reports nodes in `walk.simple`'s post-order, so which child positions count
  as nodes — non-computed member properties and object keys stay unvisited — and
  the order they arrive in are unchanged. Behaviour below the bound is identical.
  
  Catching the `RangeError` would have been the smaller change and is the wrong
  one: it makes the accept/reject boundary depend on the remaining call stack, so
  the same script passes on one code path and fails on another. The bound is a
  reported result instead.
  
  What each site returns at the bound:
  
  - **`validateCode`** adds an `invalid_value` error naming the limit and returns
    `ok: false`. A truncated walk has not proven the source clean; anything below
    the cut-off went uninspected, so reporting `ok` would be a pass on a partial
    inspection.
  - **`inferCapabilities`** returns an empty capability set *and* a `parseErrors`
    entry naming the limit. The capabilities found before the walk stopped are a
    floor, not the answer. Returning them alone would fail open in both callers:
    `migrateSavedScripts` treats an empty set as "grant `model.read` and migrate
    anyway", and the promote dialog renders it as "no `bim.*` calls detected".
    `parseErrors` is the channel both already use to refuse a script — the
    migration now skips it and the dialog shows its warning.
  
  No public API change; `walkBounded` is not exported from the package entry
  point.

- [#3070](https://github.com/LTplus-AG/ifc-lite/pull/3070) [`f1ee3e8`](https://github.com/LTplus-AG/ifc-lite/commit/f1ee3e88889281af34f0e382cef7ea57ee9d47c1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Put the entry-script scan on the package's one AST walker, and fail closed on a
  subtree the walker cannot descend.
  
  Three follow-ups to the bounded-walk work, all latent rather than live — no
  input reaching this package today takes any of the paths below.
  
  **One walker, one bound.** `src/ast/bounded-walk.ts` opened with "this module is
  the single traversal used by every AST consumer here… Callers vary the visitor;
  they do not re-implement the traversal", while `host/source-wrap.ts` ran its own
  hand-written traversal with its own private `MAX_AST_DEPTH = 1000` and its own
  generic child enumeration. Two walkers and two constants with a comment telling
  the next reader the second one did not exist. `checkBannedConstructs` now calls
  `walkBounded`; the duplicate constant and the generic `childNodes` helper are
  gone.
  
  The migration narrows which child positions get *reported* — `acorn-walk`'s
  `base` skips non-computed member properties, plain object keys, labels,
  `ExportSpecifier`s and pattern `Property` wrappers, which the generic
  property-crawl reported as nodes. It does not narrow what the scan *catches*: a
  differential run over 59 sources placing each banned construct in an exotic
  position found no banned node reached by the generic crawl and missed by
  `base`, including the pattern-default case where the `Property` wrapper is
  skipped but the `ImportExpression` under it is still visited via `ObjectPattern`.
  The accept/reject depths are unchanged for both shapes measured (`if`-nesting
  and arrow chains), and a test now pins `wrapEntrySource` and `validateCode`
  against each other across the boundary so a future divergence fails.
  
  **A missing `base` is now a failure, not a silent stop.** `walkBounded` reported
  a node it had no `base` for and skipped its entire subtree. Every caller is a
  scanner looking for things it must not find, so a skipped subtree was a scan
  that failed open: `validateCode` returned `ok`, `inferCapabilities` published an
  under-counted capability set, and `wrapEntrySource` wrapped the script — none of
  them could tell "found nothing" from "never looked". `acorn-walk` throws on a
  missing `base` for exactly this reason; we report instead of throwing because
  these callers are declared to return a result. The result now carries
  `unwalkableTypes`, and all three callers treat a non-empty list the way they
  already treat `depthExceeded`. This becomes reachable the first time acorn is
  upgraded ahead of `acorn-walk` — the skew that landed class static blocks,
  import attributes and `await using`. Verified against acorn 8.18.0 /
  acorn-walk 8.3.5: no node type the walk actually reaches is missing a base.
  (`ExportSpecifier` has no `base` entry, but `base.ExportNamedDeclaration` never
  descends into `specifiers`, so the walk never dispatches on it — it is unreached,
  not unwalkable.) The tests reproduce the skew by removing one `base` entry rather
  than waiting for an upgrade.
  
  **Two comments that named a number acorn does not have.** The walker's docstring
  claimed acorn "gives up at roughly 1200 source levels" and `source-wrap.ts`
  claimed "roughly twice this depth". Both understate — so they erred safe — but
  as written they were the numbers a future reader would cite to justify raising
  the bound. Measured on Node 22, the same script parses at 1100 source levels and
  aborts the process at 1200 in a default-stack run (a fatal V8 abort, exit 134,
  not a catchable error), is rejected at 1200 under this repo's vitest workers,
  and parses at 4000 under `node --stack-size=4000`. The parser's give-up point is
  a property of the host's remaining stack, not of acorn, and the docstring now
  says so — which is the argument for a fixed heap-based bound, not against it.
  
  `MAX_AST_DEPTH` is unchanged at 1000. No public API change; `walkBounded` is
  still not exported from the package entry point.

- [#3025](https://github.com/LTplus-AG/ifc-lite/pull/3025) [`870ec9e`](https://github.com/LTplus-AG/ifc-lite/commit/870ec9ee9a35f798196c59ce82e65e210eddd429) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make `wrapEntrySource`'s banned-construct check walk the entire entry-script AST instead of only its top-level statements.
  
  The check existed to flag `import`/`export` syntax at wrap time so extension authors get a clear, early error instead of a confusing runtime failure. It only ever inspected `ast.body`, so any of those constructs written inside a nested function, arrow body, or class method passed silently. In practice the QuickJS sandbox realm has no module loader registered, so a nested dynamic `import(...)` was always going to fail at runtime anyway with an opaque engine error — this change moves that failure earlier and makes it legible, and closes the gap between what the check's name and callers assume ("banned constructs are caught") and what it verified.
  
  The walk now also flags dynamic `import(...)` anywhere it appears, not just static top-level `import`/`export` declarations (which the ECMAScript grammar restricts to the top level regardless of where the walk looks). `eval` and `new Function` are deliberately left alone: both run confined inside the same non-module sandbox realm with no path to the host bridge, and banning them would restrict legitimate extension code for no isolation benefit.
  
  The walk iterates over an explicit stack rather than recursing, and stops at a fixed depth of 1000 AST levels. `wrapEntrySource` returns a `ValidationResult`, so a deeply nested entry script has to come back as a reported error; a recursive walk instead threw a `RangeError` ("Maximum call stack size exceeded") out of the middle of it, at roughly 500 nested blocks. Past the bound the script is now rejected with an `invalid_value` error naming the limit, matching how acorn's own parser already degrades on input it cannot handle. Real entry scripts nest a few tens of levels deep.

## 0.4.2

### Patch Changes

- [#2610](https://github.com/LTplus-AG/ifc-lite/pull/2610) [`bd92912`](https://github.com/LTplus-AG/ifc-lite/commit/bd92912965b6b1ab6573a4b304b1e54d494c22b7) Thanks [@louistrue](https://github.com/louistrue)! - Internal tidy-up only, no behaviour change: the sandbox's `try { value = fn(...) } catch (err) { throw err }` is now a plain call, which is what rethrowing an unchanged error already did.

  This ships because the repo's new lint gate flagged it (`no-useless-catch`), not because anything was wrong at runtime.

## 0.4.1

### Patch Changes

- [#2083](https://github.com/LTplus-AG/ifc-lite/pull/2083) [`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop `IfcServerClient.parseStream()` reporting a truncated stream as a successful parse, and log four failures that were previously invisible.

  **Behaviour change (`@ifc-lite/server-client`):** `parseStream()` now throws `Stream ended without a complete event` when the SSE stream finishes without a `complete` or `error` event. Previously, a connection that dropped mid-parse — or a final frame truncated mid-JSON, whose `JSON.parse` failure was swallowed by a bare `catch {}` — ended the async generator normally, so `for await (const event of client.parseStream(file))` simply exited and the caller saw a successful parse that had produced only part of the model. The sibling `parseStreamToParquet()` already enforced this contract (`Stream ended without complete event`); the two paths now agree. Consumers that `break` out of the loop early are unaffected: an early return does not run the check.

  Two further `parseStream()` fixes: a malformed SSE frame is now reported via `console.warn` instead of being dropped silently, and `yield` has been moved out of the `try` that wraps `JSON.parse`, so an error thrown into the generator by the consumer propagates instead of being swallowed as if it were a bad frame.

  New warnings elsewhere, no behaviour change:

  - `@ifc-lite/extensions` — an `AuditLog` subscriber that throws now warns once per listener (latched, so a persistently broken subscriber cannot log once per audited action). Delivery to the other listeners is unchanged.
  - `@ifc-lite/collab-server` — the layer-registry auto-merge path warns when it skips because the pushed layer cannot be read, when a ref layer cannot be read during the idempotency probe, and when a merge attempt throws. Auto-merge failures are still contained and still never fail the push that triggered them; they are just no longer invisible to the operator.
  - `@ifc-lite/sdk` — `bsdd` warns when the paginated `classProperties` fallback fails. The partial result is still returned, but it is also cached, so one transient failure otherwise answered every later call for that URI until the entry expired.

## 0.4.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

## 0.3.5

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 0.3.4

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 0.3.3

### Patch Changes

- [#1487](https://github.com/LTplus-AG/ifc-lite/pull/1487) [`54b5c6b`](https://github.com/LTplus-AG/ifc-lite/commit/54b5c6b043ebd83dc9b10bd15e9973e6a58293cb) Thanks [@louistrue](https://github.com/louistrue)! - Pin the gzip MTIME header to 0 in `packBundle` so `.iflx` bytes are deterministic for the same input. Previously the header embedded wall-clock seconds, so re-packing identical content in a different second produced a different content-addressed bundle hash (and flaked the determinism test). Matches the fix already shipped in the flavor packer.

## 0.3.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 0.3.1

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

## 0.3.0

### Minor Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

## 0.2.0

### Minor Changes

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 2 authoring pipeline — parsing, repair loop, diagnostics.

  Closes 5 more plan tasks (P2.T8, T9, T10, T16, T17). The chat-side
  authoring loop now has every library piece it needs to drive the LLM
  through plan → bundle → validate → repair → install.

  - **`authoring/synthesize.ts`** (T8/T9/T10) — `parseBundleOutput`
    extracts fenced `ifc-extension-manifest` / `ifc-extension-code` /
    `ifc-extension-widget` blocks from a chat response into a
    structured bundle. Manifest + widget JSON parsed; code stays as
    text. Surfaces structured errors on missing path attributes,
    duplicate manifest blocks, code-without-manifest. Bug found during
    development: the original regex used `\s+` for the attribute
    separator which greedily ate the JSON via `\n` matching as
    whitespace — fixed to `[ \t]+`, reproducer in tests.

  - **`authoring/repair.ts`** (T16) — `runRepairLoop` drives the
    authoring loop: calls the LLM `AuthoringStep`, validates the
    response (manifest + widgets + code + cross-references +
    capabilities), feeds structured diagnostics back as a user turn,
    retries up to `maxAttempts` within `totalBudgetMs`. Per-attempt
    wall-clock budget enforced via promise race. Defensive copies of
    the conversation passed to the step so callers can't mutate the
    internal buffer.

  - **`authoring/repair.ts:validateBundleResponse`** — single-pass
    validation: manifest → widgets → code → cross-reference. Used by
    both the repair loop and by callers that just want to validate an
    output without retrying.

  - **`authoring/diagnostics.ts`** (T17) — `groupDiagnostics` /
    `renderDiagnostics` / `summariseDiagnostics`. Groups errors by
    leading scope (handles both JSON paths and file paths
    correctly), renders markdown-ish blocks for the chat UI, produces
    short summaries for toasts / headers.

  Tests: 504 (up from 482 / +22). New test files: `synthesize.test.ts`,
  `repair.test.ts`, `diagnostics.test.ts`. Two real bugs caught by
  tests during development — the fence-regex greedy-eat and the
  diagnostic scope leading-segment split.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Flavor `.iflv` packing + prompt overlay helpers + plan-stub generator.

  Closes 4 more plan tasks on the library side. All host-agnostic, fully
  tested headlessly.

  - **`flavor/packer.ts`** (P3.T7, P3.T9) — `packFlavor(flavor, opts)`
    produces a gzipped JSON `.iflv` envelope embedding the flavor plus
    optionally each extension's `.iflx` bytes. `unpackFlavor(bytes)`
    validates the envelope, runs the flavor through `validateFlavor`,
    and surfaces decoded extension bundles. Same deterministic-output
    guarantee as `.iflx`. Strict base64 decode hardens against silently
    corrupted payloads.
  - **`flavor/overlay.ts`** (P4.T11) — `clampOverlay(content)` trims +
    applies the 4000-token soft cap (configurable) before persisting the
    personal prompt overlay; `overlayParagraphDiff(prev, next)` lets the
    memory-extractor UI highlight added vs. removed paragraphs.
  - **`miner/plan-stub.ts`** (P4.T7) — `planFromPattern(pattern)`
    translates a mined `MinedPattern` into an `AuthoringPlan` skeleton:
    one command + one toolbar contribution; capabilities unioned from a
    conservative per-intent map; one fixture-bound smoke test; notes
    field attributes the pattern occurrence count and last-seen time.

  Side fix: `signing/base64.ts:fromBase64` is now strict (length % 4,
  regex-validated alphabet). Was lenient before; corrupted payloads
  would silently decode to garbage on Node. Matches the bundle/iflx
  hardening from the PR-review pass.

  Tests: 445 (+24 across 3 new test files). All source files under 400
  lines.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 1 UI finish + Phase 2 authoring kernel + Phase 4 integration.

  Closes 14 plan tasks across three phases. Big-impact session — the
  extensions system is now reachable end-to-end on the web: chat →
  script → promote → review → install → command-palette → toolbar →
  audit-log.

  **Phase 1 — UI finish:**

  - **P1.T8 command palette merge** — `CommandPalette.tsx` now reads
    `commandPalette` slot contributions, surfaces them under a new
    "Extensions" category, and dispatches via the new `runCommand`
    host method.
  - **P1.T9 toolbar slot** — `ExtensionToolbarSlot.tsx` renders
    `toolbar.right` contributions with `when`-clause visibility
    evaluation against a viewer-state context; mounted in `MainToolbar`.
  - **P1.T11/T12 promote-to-tool** — `PromoteToolDialog.tsx` button in
    `ScriptPanel.tsx` (Sparkles icon next to Save). Reads the editor
    source, infers a minimal capability set via `inferCapabilities`,
    synthesises a single-command bundle (manifest + handler wrapper),
    routes through `CapabilityReview` for the security gate, installs.
  - **P1.T17 audit log UI** — `AuditLogPanel.tsx` with kind filter
    chips, per-event tones, JSON export, clear. Toggled inside the
    Extensions panel header.

  **Phase 2 — AI authoring kernel:**

  - **P2.T1 intent classifier** — `authoring/classify.ts`. Rule-based
    routing: one-shot / authoring / fork / out-of-scope. Refusal
    matchers for path-traversal, shell-exec, npm-install, and
    exfiltration phrasing.
  - **P2.T3 plan card** — `PlanCard.tsx` renders an `AuthoringPlan`
    with editable summary, contribution removal, capability opt-out,
    risk-tier badges, and test summary. Approve/cancel route to host.
  - **P2.T6 authoring contract prompt** — `authoring/prompt.ts`.
    `buildAuthoringContract()` returns the static, cacheable prompt
    fragment: manifest schema, widget DSL table, capability catalogue
    with risk tiers, style rules, test convention, failure modes.
    Deterministic for cache-hit reliability.
  - **P2.T20/T21/T22 widget renderer** — `widget/WidgetRenderer.tsx`
    walks the 15 DSL node types into matching React components. Data
    bindings resolve via JSONPath-ish `"$.foo.bar"`. Buttons dispatch
    through a `WidgetRendererContext.invokeCommand` callback so
    widgets stay command-id-driven (no closures, no inline scripts).

  **Phase 3 — saved-scripts migration:**

  - **P3.T15** — `flavor/migrate-scripts.ts`. `migrateSavedScripts(scripts)`
    produces a starter flavor + per-script synthetic extension bundles.
    Capability inference per script; conservative fallback to
    `model.read`. Tests cover slug stability, namespace override,
    parse-failure skip.

  **Phase 4 — self-improvement integration:**

  - **P4.T6 filter against installed** — `miner/filter.ts`.
    `filterAgainstInstalled` drops mined patterns the user already has
    an extension covering, based on a capability → intent reverse map.
  - **P4.T8 idle scheduler** — `miner/scheduler.ts`. `IdleMineScheduler`
    re-arms a debounced timer on every action-log push, fires the
    miner on idle, respects a min-interval floor, dispatches scored
    patterns to subscribers.
  - **P4.T12 system prompt overlay** — `system-prompt.ts` (viewer)
    appends the active flavor's prompt overlay inside a dedicated
    cacheable trailing section.

  **Viewer host service:**

  - `ExtensionHostService.runCommand(id)` — looks up the owning
    extension, activates it (idempotent), loads the entry handler
    source, wraps with `wrapEntrySource`, runs in the sandbox.

  Tests: 482 (up from 445 / +37). All source files under the 400-line
  cap. No new test files for UI components (Vercel preview verifies);
  new test files: `authoring/classify.test.ts`, `authoring/prompt.test.ts`,
  `flavor/migrate-scripts.test.ts`, `miner/scheduler.test.ts`,
  `miner/filter.test.ts`.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Introduce `@ifc-lite/extensions` package and the `ifc-lite ext` CLI
  subcommand — the Phase 0 foundation of the user-customization /
  AI-authored-extensions system designed in
  `docs/architecture/ai-customization/`.

  The package exposes:

  - **Manifest validator** — hand-rolled, dependency-free; produces
    structured `{ path, code, hint }` errors for use by the future
    AI repair loop.
  - **Capability grammar** — parser, matcher, OCAP catalogue, risk
    classifier, and set-diff for re-consent flows.
  - **`when` clause language** — parser + evaluator for the slot
    visibility expressions used by host UI.
  - **`SlotRegistry`** — in-memory pub/sub for contribution points;
    the substrate for Phase 1's host UI bindings.
  - **Bundle loader and `.iflx` pack/unpack** — directory and gzipped
    JSON envelope variants, deterministic round-trip.

  The CLI adds `ifc-lite ext validate <path>` (returns structured JSON
  with `--json`) and `ifc-lite ext init <dir>` (scaffolds a minimal
  valid bundle).

  No host integration yet. UI loader, runtime activation, sandbox
  wiring, audit log, AI authoring, flavors, and self-improvement loops
  arrive in subsequent phases.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 1 — end-to-end `entry.activate(ctx)` execution.

  The activation runtime now actually runs extension entry scripts. The
  calling convention for v1 is settled:

  - Entry files are **plain JavaScript** that define a top-level function
    matching the entry name (`activate`, `deactivate`, or a command
    handler id).
  - The function takes a `ctx` parameter; for v1, `ctx = { bim }` only.
    Future ctx fields (`fetch`, `storage`, `notify`, `onDispose`, `t`,
    `meta`) hang off the same contract — no rewrite required.
  - ES module syntax (`import`, `export`) is **not supported** in v1.
    The source-wrap parser rejects it with structured errors; the CLI
    scaffold writes the right shape.
  - Async user code is fire-and-forget at activation: the IIFE may
    return a Promise (`activateResult.value`), but the runtime does not
    await it. Long-running work belongs on command/trigger fires.

  Three new modules:

  - **`host/source-wrap.ts`** — wraps user source as an IIFE that
    installs `__ifclite_ctx__` and `bim`, then invokes the entry
    function. Validates with acorn; rejects `import`/`export`
    statements before the sandbox ever sees the code.
  - **`host/memory-factory.ts`** — `createMemorySandboxFactory()`. Host
    realm `new Function()`-backed factory for headless tests. **Not a
    security boundary** — documented in-file. Production hosts use the
    QuickJS factory that ships with the viewer.
  - **`host/runtime.ts`** (extended) — `ExtensionRuntime.activate(id, grants, bundle)`
    reads the entry script from the bundle, wraps it, runs it, captures
    logs + duration + return value. Disposes the sandbox on any
    failure. `deactivateWithBundle` mirrors the flow for the optional
    `entry.deactivate` script.

  Test count: 307 (up from 269 / +38). The activation flow tests use
  the in-memory factory to exercise the full pipeline end-to-end —
  bundle in, IIFE out, activateResult captured. The viewer-side QuickJS
  factory adapts `Sandbox.eval` to the same `RuntimeSandboxHandle.run`
  shape; that wiring lands with the UI integration.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 1 — extension activation runtime (security layer).

  Three new host-side modules:

  - **`host/permissions.ts`** — `capabilitiesToPermissions(grants)`
    derives the existing `@ifc-lite/sandbox` permission flags from a
    fine-grained capability set. This is the **outer ring**: a
    whole-namespace gate the sandbox enforces.
  - **`host/runtime.ts`** — `ExtensionRuntime` manages a sandbox per
    active extension. Uses a pluggable `RuntimeSandboxFactory` so the
    viewer can wire `@ifc-lite/sandbox` in while tests / CLI use stubs.
    Idempotent activate / deactivate / disposeAll.
  - **`host/check.ts`** — `checkMethodCall` / `assertMethodCall` /
    `CapabilityDeniedError`. The **inner ring**: per-`bim.<ns>.<method>`
    capability check used by the future bridge wrapper. Defence in depth
    — even if the sandbox flag would allow the call, the method-level
    check refuses it without an explicit capability grant.

  The runtime does **not** yet invoke `entry.activate(ctx)` — that
  requires settling a cross-realm `ctx` calling convention for QuickJS
  (the existing sandbox uses globals, not parameter passing). That
  design lands with the viewer-side UI wiring. The runtime exposes the
  sandbox handle so the host can drive script evaluation when ready.

  Test count: 269 (up from 231 / +38). Coverage includes every
  capability scope's permission derivation, the activation lifecycle,
  idempotence, factory error propagation, and the inner-ring method
  check for both pass and deny paths.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 1 Stage A — host-agnostic library layer for the extension system.

  New modules:

  - **Storage** (`/storage`) — `ExtensionStorage` interface,
    `InstalledExtensionRecord` type, `InMemoryExtensionStorage`
    implementation for tests/CLI, SHA-256 bundle hashing via WebCrypto.
  - **Host** (`/host`) — `ExtensionLoader` (composes storage + manifest
    validation + slot registry + activation dispatcher), and
    `ActivationDispatcher` (event-driven at-most-once activation per
    session, with sequential async listener semantics).
  - **Audit** (`/audit`) — append-only ring buffer with byte + count
    caps, JSON export, filter API for the future security review UI.
  - **Inference** (`/inference`) — acorn-based AST walker that turns a
    saved script into a minimum capability set for the "Promote to tool"
    UX. Conservative: ambiguous calls over-grant rather than under-grant.

  Dependencies added: `acorn` and `acorn-walk` (tiny, standard ES parser
  used by ESLint/Webpack/Babel; chosen over zero-dep regex to avoid
  under-granting on edge cases).

  UI integration (viewer-side React provider, Promote-to-Tool dialog,
  capability review screen, Settings → Extensions page) and the
  sandbox capability bridge are intentionally not in this changeset.
  They land in the next batch where browser interactivity is verifiable.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Viewer UI integration for the extension system (Phase 1 UI batch).

  Web-reachable surface: the Settings page is desktop-only, so the
  extension surface is now a togglable right-dock panel reachable from
  the Command Palette ("Extensions"). It mirrors how IDS / BCF / Lens
  panels are surfaced.

  New viewer modules (`apps/viewer/src/`):

  - `services/extensions/idb-storage.ts` — IndexedDB-backed
    `ExtensionStorage` implementing the package interface. Two object
    stores keyed by `id` and `<id>@<version>`. Recovery rebuild on
    schema mismatch (mirrors `services/ifc-cache.ts`).
  - `services/extensions/sandbox-factory.ts` — adapts
    `@ifc-lite/sandbox.createSandbox` to the package's
    `RuntimeSandboxFactory`. Maps `run` to `Sandbox.eval`, threads
    `setGlobal` through prepended assignments, marshals log entries.
  - `services/extensions/host.ts` — `ExtensionHostService` singleton:
    composes storage + slot registry + activation dispatcher + extension
    runtime + audit log behind one facade. Exposes `init`,
    `previewBundle`, `installFromBytes`, `uninstall`, `setEnabled`,
    `listInstalled`, slot subscriptions, change signal.
  - `sdk/ExtensionHostProvider.tsx` — React context built on top of
    `BimProvider`; service identity is stable across renders.
  - `hooks/useSlotContributions.ts`, `hooks/useInstalledExtensions.ts` —
    thin reactive hooks.
  - `components/extensions/ExtensionsPanel.tsx` — dock panel: install
    via drag-drop / file picker, list with enable/disable/uninstall.
  - `components/extensions/CapabilityReview.tsx` — modal with per-row
    risk badges (green/yellow/red), opt-out per capability, typed
    "approve" confirmation for red-tier grants.
  - `store/slices/extensionsSlice.ts` — `extensionsPanelVisible` toggle
    state.

  Wired into existing surfaces:

  - `App.tsx`: `<ExtensionHostProvider>` wraps the routed content
    inside `<BimProvider>`.
  - `ViewerLayout.tsx`: renders `ExtensionsPanel` on both desktop and
    mobile branches when visibility flag is set.
  - `CommandPalette.tsx`: new "Extensions" entry under the Panels
    category that exclusively activates the dock panel and uncollapses
    the right panel.

  Package-side change: `@ifc-lite/extensions/audit/log.ts` —
  `AuditLog.append`'s input type now uses `DistributiveOmit` so per-kind
  fields (`reason` on `unhealthy`, `previousVersion` on `update`) stay
  visible to TypeScript without call-site casts.

  Tests still 307 (no new test additions this turn; viewer-side React
  Testing Library coverage lands with the user's browser verification
  pass). No regressions in any of the 22 existing test files.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Library-layer ground for Phase 2 / Phase 3 / Phase 4.

  This batch fills in the host-agnostic data layers across three phases.
  No viewer/CLI integration in this changeset — the UI surfaces hook into
  these in subsequent work.

  **Phase 3 — Flavors (`/flavor`):**

  - `types.ts` — `Flavor`, `FlavorExtension`, `SavedLens`, `SavedQuery`,
    `KeybindingOverride`, `LayoutOverride`, `PromptOverlay`,
    `FlavorAuthor`, `FlavorSnapshot`.
  - `schema.ts` — hand-rolled `validateFlavor` mirroring the manifest
    validator pattern.
  - `diff.ts` — structured `diffFlavors(theirs, ours)` producing
    per-section diffs (extensions / lenses / saved queries /
    keybindings / settings / prompt overlay).
  - `merge.ts` — three-way `mergeFlavors(base, theirs, ours)` with
    conflict surfacing. Extensions union by id with higher-semver
    version + capability intersection; settings per-key with
    base-aware resolution; prompt overlay appended with separator.
  - `storage.ts` — `FlavorStorage` interface + `InMemoryFlavorStorage`
    with auto-snapshot on every write (cap configurable) and
    active-flavor pointer.

  **Phase 4 — Action log + miner (`/log`, `/miner`):**

  - `log/types.ts` — `ActionEvent` discriminated union over
    ~18 intent kinds (model.load, lens.apply, export.run, ...) with
    intent-specific `params` schemas. Privacy by construction —
    params hold metadata, never content.
  - `log/writer.ts` — `ActionLog` append-only buffer with UTF-8
    byte cap, count cap, deep-frozen records, subscribe API for
    reactive observers, JSON export.
  - `miner/sequence.ts` — `mineSequences` finds frequent n-gram
    intent patterns per session, filtered by occurrence + distinct-
    session thresholds. `splitSessions` separates events by
    configurable gap.
  - `miner/score.ts` — `scorePattern` combines frequency × recency
    × session diversity with exponential decay; `topPatterns` ranks
    for the suggestion UI.

  **Phase 2 — library bits (`/authoring`, `/widget`, `/validate`):**

  - `authoring/plan.ts` — `AuthoringPlan` schema + `validatePlan`.
    Holds `summary`, `rationale`, `contributions`, `capabilities`,
    `triggers`, `widgets`, `tests` for the plan-before-code UX.
  - `widget/schema.ts` — declarative widget DSL: 15 node types
    (Stack, Group, Text, Field, Button, Table, Chart, Markdown,
    Tabs, Separator, EmptyState, Spinner, ErrorBanner, EntityList,
    Tree, KeyValueGrid). `validateWidget` walks the tree.
  - `validate/code.ts` — acorn-based AST walker rejecting banned
    globals (`globalThis`, `window`, `process`, `document`, `self`),
    banned calls (`eval`, `Function`), and dynamic `import()` with
    non-literal specifiers or unauthorised paths.
  - `validate/cross-ref.ts` — `crossReferenceBundle` confirms entry
    paths, widget paths, lens / exporter / IDS validator handlers
    resolve; optionally validates test fixture ids against a
    catalogue.

  Top-level barrel exports each new module group via `export *`.

  Plan completions (13 tasks): P2.T2, P2.T11, P2.T12, P2.T19;
  P3.T1, P3.T2, P3.T3, P3.T10, P3.T12; P4.T1, P4.T2, P4.T4, P4.T5.

  Tests: 421 (up from 337 / +84). New test files:

  - `flavor/flavor.test.ts` (18 cases)
  - `log/log.test.ts` (12 cases)
  - `miner/miner.test.ts` (9 cases)
  - `widget/widget.test.ts` (11 cases)
  - `validate/code.test.ts` (13 cases)
  - `validate/cross-ref.test.ts` (10 cases)
  - `authoring/plan.test.ts` (6 cases)

  All source files under the 400-line cap.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 3 + 4 completion — flavor switcher, test runner, SDK
  revalidation, memory extractor, miner integration.

  Library additions across this batch:

  - **Test runner** (`testing/runner.ts`, `testing/synthetic.ts`):
    `runBundleTests` drives a bundle's declared `manifest.tests` against
    the existing `ExtensionRuntime`. Matchers: mimeType / byte range /
    regex / jsonShape. Synthetic fixtures provide a content-free
    `bim` ctx with `query.byType` + `query.count` so tests can run
    without real IFC files. Canonical residential-small /
    office-medium / empty-model included.
  - **Dry-run profile** (`dryrun/profile.ts`): RFC §02.5 budgets
    (25 % memory, 50 % CPU of production) for the authoring loop's
    transient runtime.
  - **SDK version + revalidation** (`host/sdk-version.ts`,
    `host/sdk-revalidate.ts`): hand-rolled semver-lite matcher and the
    revalidate orchestrator that re-runs manifest tests for every
    installed extension whose engine range no longer matches the
    candidate SDK.
  - **Flavor switcher** (`flavor/switcher.ts`): three-step
    enable/disable/load orchestration with full rollback on any failure
    (deactivate throw, reload returning false, pointer-write failure).
  - **Memory extractor** (`flavor/memory-extractor.ts`): rule-based
    preference scanner over chat transcripts with a strict content
    blocklist (GUIDs, paths, emails, API keys). `mergeIntoOverlay`
    seeds a Preferences section and deduplicates.
  - **Eval suite** (`eval/loops.test.ts`): end-to-end coverage of the
    three §06 loops — planted-pattern miner, memory-extractor leak
    prevention, SDK-update flagging.

  Test count: 558 across 49 files, all passing.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - Phase 5 prototype — Ed25519 signing for extension bundles.

  The hosted registry is gated on a decision criterion (50 flavors / 10
  authors before opening), but the cryptographic kernel ships today so
  the design isn't abstract and authors can sign bundles before any
  registry exists.

  New design doc:
  `docs/architecture/ai-customization/10-registry-and-signing.md` —
  distribution threat model, signing scheme, key management, signed
  envelope shape, verification flow, registry architecture sketch,
  trust UX (TOFU), revocation, phase 5 build plan, non-goals, open
  questions.

  New `@ifc-lite/extensions/signing` module:

  - **Keys** — `generateKeyPair`, `exportPublicKey`, `exportPrivateKey`,
    `importPublicKey`, `importPrivateKey`, `fingerprintFromBytes`.
    Uses WebCrypto Ed25519 (Node ≥ 18.17, modern browsers). Keys
    serialise as `.iflk` JSON files with format/version/algorithm
    discriminator. Fingerprints are colon-separated SHA-256 of the
    raw 32-byte public key.
  - **Canonical hashing** — `canonicalContentHash` produces a
    deterministic SHA-256 over the bundle's file map. Insertion-order-
    independent; uses ASCII unit/record separators between
    path/bytes/record to make segment boundaries unambiguous.
  - **Sign / verify** — `signBundle` produces a `SignatureBlock`
    committed to the canonical hash. `verifyBundle` recomputes, checks
    format, imports key, runs `crypto.subtle.verify`. Throws
    `SignatureMismatchError` on any failure;
    `SignatureFormatError` for envelope-shape problems;
    `KeyFormatError` for malformed key files.

  `.iflx` envelope extension:

  - Optional `signature` field on pack / unpack.
  - `packBundle(bundle, signature?)` accepts a signature argument.
  - New `unpackBundleWithSignature(bytes)` returns
    `{ bundle, signature? }` so callers (loader, CLI) can verify and
    display the signer fingerprint.
  - Existing `unpackBundle` continues to work — signed bundles unpack
    fine, the signature is silently ignored. Backward-compatible.

  New CLI subcommands under `ifc-lite ext`:

  - `keygen --out <prefix> [--label <name>]` — Ed25519 keypair, writes
    `.public.iflk` and `.private.iflk`. Best-effort POSIX 0600 on the
    private file.
  - `pack <bundle-dir> [--out <bundle.iflx>] [--sign --key <private.iflk>]`
    — pack a bundle directory into `.iflx`, optionally signed.
  - `sign <bundle> --key <private.iflk> [--out <bundle.iflx>]` —
    attach a signature to an existing bundle (directory or unsigned
    `.iflx`).
  - `verify <bundle.iflx> [--key <public.iflk>] [--json]` — inspect
    a `.iflx`, optionally checking the signer matches an expected
    public key. JSON mode emits a structured envelope.

  Package-side housekeeping:

  - `packages/extensions/tsconfig.json`: added `"DOM"` to `lib` so
    WebCrypto types (`CryptoKey`, `CryptoKeyPair`) are available. Was
    already implicitly required for `crypto.subtle` calls in
    `storage/hash.ts`.
  - Top-level barrel exports the new signing surface.

  Tests: 333 (up from 307 / +26). New coverage: keypair generation
  identity, public/private key file round-trip, canonical hash
  determinism and order-independence, sign+verify happy path,
  content tamper detection, contentHash tamper, substituted public
  key, algorithm/format error paths, signed `.iflx` envelope
  round-trip, tamper detection through the pack→unpack→verify chain.
  Smoke-tested end-to-end against the canonical `good` bundle
  fixture.

  Plan tracked in `09-implementation-plan.md` — P5.T2 closed,
  P5.T1/T3-T8 remain gated on the registry decision.

- [#690](https://github.com/LTplus-AG/ifc-lite/pull/690) [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d) Thanks [@louistrue](https://github.com/louistrue)! - PR [#690](https://github.com/LTplus-AG/ifc-lite/issues/690) review pass — security and correctness fixes from CodeRabbit.

  Critical / security fixes:

  - **`capability/match.ts`** — universal wildcard target no longer
    bypasses the required-target check. `model.mutate:*` now correctly
    refuses to cover `model.mutate` (no target). The two are
    structurally different and matching them would silently broaden
    authority. Regression test added.
  - **`signing/sign.ts` + `signing/verify.ts`** — `signedAt` is now
    cryptographically bound to the signature via a versioned
    domain-separated message (`iflx-sig\x1fv1\x1f<hash>\x1f<signedAt>`).
    Previously only `contentHash` was signed, so `signedAt` could be
    rewritten post-signing without detection. Regression test added.
  - **`signing/keys.ts`** — `importPrivateKey` now enforces
    `kind: 'private'` and wraps base64 / PKCS#8 parse errors in
    `KeyFormatError` rather than letting them bubble up as raw
    WebCrypto exceptions.
  - **`apps/viewer/src/services/extensions/host.ts`** — install path
    rejects `grantedCapabilities` not declared by the manifest (closes a
    grant-escalation hole if the review screen pre-filled stale state).
  - **`audit/log.ts`** — eviction now uses UTF-8 byte counts (via
    `TextEncoder.encode().byteLength`) instead of UTF-16 string length;
    records are deep-frozen on append so callers can't mutate stored
    events.
  - **`bundle/loader.ts`** — added a 16 MiB aggregate bundle cap during
    directory traversal so a thousand 4 MiB files can't OOM the loader.
  - **`bundle/iflx.ts`** — base64 decode is now strict (matches the
    base64 alphabet + correct padding) so Node's silently-lossy
    `Buffer.from(b64, 'base64')` no longer accepts corrupted bundles.
  - **`migrations/index.ts`** — `manifestVersion` validated as a
    positive integer (rejects `NaN`, `Infinity`, negatives, non-int
    doubles).
  - **`manifest/validate.ts`** — extension id regex dropped the `/i`
    flag so the validator actually enforces the lowercase canonical-id
    promise.
  - **`host/activation.ts`** — extension is marked `activated` only
    after listeners succeed (a throwing listener used to leave the
    extension permanently uneligible to retry). New `activating` flag
    guards against re-entrant double-dispatch.
  - **`host/runtime.ts`** — concurrent `activate()` calls for the same
    id are coalesced via an in-flight Promise map. Previously two
    overlapping calls could both build a sandbox and leak one.
  - **`inference/catalogue.ts`** + **`when/eval.ts`** — own-property
    checks instead of `in` / bracket access. Prototype-pollution-style
    lookups like `toString` now return undefined / no capability.
  - **`when/eval.ts`** — identifier lookup is gated by the v1 allow-list
    even if the context object happens to carry extra keys.

  Correctness / quality fixes:

  - **`apps/viewer/.../host.ts`** — `init()` only sets `initialized=true`
    after `loadAll` + `fire('onStartup')` succeed; uninstall explicitly
    deletes the bundle bytes; enable persists `enabled=true` only after
    the loader successfully brings the extension up (rolls back on
    failure); update path snapshots the previous record + bundle bytes
    and restores them if the new bundle fails to load.
  - **`idb-storage.ts`** — `onblocked` handler on
    `indexedDB.deleteDatabase` so the recovery rebuild can't hang
    forever when another tab holds a connection. Cascade bundle delete
    rewritten to use a dedicated transaction (the previous version's
    `onsuccess` got clobbered by the shared `runStore` helper).
  - **`ext-signing.ts`** — `verify --key <pub>` on an unsigned bundle
    now exits 2 (with structured error in `--json` mode) instead of
    passing silently. `keygen`'s chmod failure logs a warning so users
    on non-POSIX FS aren't quietly left with a 0644 private key.
  - **`bundle/iflx.ts`** — signature envelope re-parse failures log a
    warning instead of silently swallowing.
  - **`ExtensionsPanel.tsx`** — duplicate install submission guard
    (`busy` check in `handleApprove`); enable/disable/uninstall now
    catch rejections and surface a toast.
  - **`useInstalledExtensions.ts`** — `refresh()` wraps `listInstalled()`
    in try/catch (no more unhandled promise rejections).
  - **`useSlotContributions.ts`** — refreshes the snapshot synchronously
    when `host` or `slot` changes, so switching slots doesn't show
    stale contributions until the next registry event.
  - **`ExtensionHostProvider.tsx`** — async `init()` / `dispose()`
    failures are caught and logged.
  - **`sandbox-factory.ts`** — `JSON.stringify` failure in log
    marshalling logs the error instead of silently falling back.
  - **`ViewerLayout.tsx`** — mobile bottom sheet title and close
    handler now include the extensions panel (was missed in the UI
    batch).

  New tests:

  - `capability/match.test.ts` — universal wildcard does NOT cover
    target-less request.
  - `signing/signing.test.ts` — signedAt tamper detected by verify.
  - `host/activation.test.ts` — listener throw leaves extension
    activatable.
  - `host/runtime.test.ts` — concurrent activate() calls coalesce.

  Tests: 337 (up from 333 / +4).
