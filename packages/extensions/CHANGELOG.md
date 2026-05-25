# @ifc-lite/extensions

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
