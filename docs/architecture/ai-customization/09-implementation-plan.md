# 09 — Implementation Plan

This document is the operational counterpart to the design RFC. It breaks
each phase into concrete, trackable tasks with explicit acceptance
criteria, file paths, dependencies, and effort estimates. It is meant to
be edited in-place: check boxes as work lands, add notes inline,
re-estimate when reality disagrees.

## How to read this document

- Tasks are numbered `P<phase>.T<n>`. Stable IDs; never renumber.
- Each task block lists: **what**, **where** (file paths), **depends on**,
  **acceptance**, **effort** (S/M/L/XL).
- A milestone is a coherent slice of a phase. Milestones gate visible
  user-facing progress; tasks gate code.
- Effort scale: **S** = < 1 day, **M** = 1-3 days, **L** = 3-7 days,
  **XL** = 1-2 weeks. Aggressive but honest.
- Risk flags: `[security]` `[perf]` `[ux]` `[upstream]` mark tasks that
  need extra review attention.

## How to track progress

- Check the box on commit, not on plan.
- When a task changes scope, leave the original line, strike through
  removed parts, add new sub-tasks under it.
- When a task is blocked, add `Blocked: <reason>` underneath the box.
  Do not silently skip.
- At the start of each phase, re-read the dependencies; rework the
  ordering if the previous phase changed the surface.
- Use the milestone tables at the top of each phase as the read-out for
  status updates.

## Cross-cutting workstreams

These workstreams run alongside every phase. Each task in a phase
inherits the relevant workstream requirements; we do not enumerate
those requirements per task.

| Stream | Requirement |
|---|---|
| **Testing** | Every new module ships with vitest tests covering its public API. No `--passWithNoTests`. Coverage threshold ≥ 70% for new code. |
| **Types** | No `as any`, no `@ts-ignore` without a linked issue. External libs without types get `.d.ts` stubs. |
| **License headers** | Every new source file carries the MPL-2.0 header from `LICENSE_HEADER.md`. |
| **Changesets** | Every package change touching `packages/*` gets a changeset via `pnpm changeset`. |
| **Docs** | Every user-visible feature updates the relevant guide under `docs/guide/`. New packages get a guide page. |
| **Security review** | Tasks marked `[security]` require a second-pair review before merge. The review checks against the threat model in `02-security.md`. |
| **Perf** | Tasks marked `[perf]` ship with before/after measurements against a canonical fixture. |
| **A11y** | Every UI task ships with keyboard-navigability and screen-reader test in Playwright. |
| **Telemetry** | Anything touching the action log or the audit log re-reads `06-self-improvement.md §2` for the no-content rule. |

## Pre-flight (before Phase 0)

Two tasks before any implementation code.

- [ ] **PRE.T1** — RFC sign-off. Stakeholders read the spec; record
  approvals or required changes. Update RFC if any change requested.
  **Acceptance:** owner field filled in README; design approval noted
  in commit log. **Effort:** S.
- [ ] **PRE.T2** — Implementation tracking issue. Open
  `.github/ISSUE_TEMPLATE/feature.md`-style master issue mirroring this
  document. Link individual PRs back to task IDs.
  **Acceptance:** issue open, labeled `epic:ai-customization`, linked
  from this doc. **Effort:** S.

---

## Phase 0 — Foundations (1-2 weeks)

Build the package and the manifest. No UI yet. The goal is: a manifest
parses, capabilities parse, and the CLI returns a structured error on
bad input, with tests for all of it.

| Milestone | Tasks | User-visible? |
|---|---|---|
| 0.A Package scaffold | T1-T3 | No |
| 0.B Manifest schema | T4-T6 | No |
| 0.C Capability grammar | T7-T9 | No |
| 0.D Slot registry skeleton | T10-T11 | No |
| 0.E CLI validate | T12-T14 | Indirect (CLI users) |
| 0.F Eval fixtures | T15-T17 | No |

### Milestone 0.A — Package scaffold

- [ ] **P0.T1** — Create `packages/extensions/` workspace package.
  **Where:** `packages/extensions/{package.json,tsconfig.json,src/index.ts}`.
  Includes vitest config, MPL header, README skeleton.
  **Depends on:** PRE.T1.
  **Acceptance:** `pnpm -F @ifc-lite/extensions build` succeeds with
  empty `index.ts`; `pnpm -F @ifc-lite/extensions test` runs (no tests
  yet) returning zero.
  **Effort:** S.

- [ ] **P0.T2** — Add `@ifc-lite/extensions` to `pnpm-workspace.yaml`
  and `turbo.json` pipeline.
  **Where:** `pnpm-workspace.yaml`, `turbo.json`.
  **Depends on:** P0.T1.
  **Acceptance:** `pnpm build` at root includes the new package.
  **Effort:** S.

- [ ] **P0.T3** — Wire `@ifc-lite/extensions` into the viewer's
  dependency graph (not yet imported).
  **Where:** `apps/viewer/package.json`.
  **Depends on:** P0.T1.
  **Acceptance:** workspace install resolves; viewer still builds.
  **Effort:** S.

### Milestone 0.B — Manifest schema

- [ ] **P0.T4** — Implement `ExtensionManifest` Zod schema per
  `01-extension-model.md §1`.
  **Where:** `packages/extensions/src/manifest.ts`.
  **Depends on:** P0.T1.
  **Acceptance:** schema parses every example in the RFC; rejects
  malformed inputs with structured `{ path, code, hint }` errors.
  Tests cover ≥ 20 positive and ≥ 30 negative cases.
  **Effort:** M.

- [ ] **P0.T5** — Bundle layout walker. Reads a directory or a
  `.iflx` and returns a `Bundle` value with manifest + file map.
  **Where:** `packages/extensions/src/bundle/{loader.ts,iflx.ts}`.
  **Depends on:** P0.T4.
  **Acceptance:** loads from disk and from `Uint8Array` (gzip-tar);
  rejects bundles missing `manifest.json` or referenced entry
  modules. Tests with three fixture bundles.
  **Effort:** M.

- [ ] **P0.T6** — Manifest version + migration scaffold.
  **Where:** `packages/extensions/src/migrations/index.ts`,
  `packages/extensions/src/migrations/v1.ts` (no-op).
  **Depends on:** P0.T4.
  **Acceptance:** loader calls migration chain; future v2 slot
  visible; tests verify a stub migration runs.
  **Effort:** S.

### Milestone 0.C — Capability grammar

- [ ] **P0.T7** — Capability grammar parser + matcher per
  `02-security.md §3`. `[security]`
  **Where:** `packages/extensions/src/capability/{parse.ts,match.ts,catalogue.ts}`.
  **Depends on:** P0.T1.
  **Acceptance:** parses all listed capability strings; rejects
  malformed ones; `match(grant, requested)` correctly handles globs,
  exacts, wildcards. Catalogue is an exported enum. Tests cover the
  grammar exhaustively (≥ 50 cases).
  **Effort:** M.

- [ ] **P0.T8** — Risk-badge computation. Map a capability list to a
  red/yellow/green badge per `02-security.md §4`.
  **Where:** `packages/extensions/src/capability/risk.ts`.
  **Depends on:** P0.T7.
  **Acceptance:** plain-English description table; deterministic
  output; tests cover each badge tier.
  **Effort:** S.

- [ ] **P0.T9** — Capability diff function.
  **Where:** `packages/extensions/src/capability/diff.ts`.
  **Depends on:** P0.T7.
  **Acceptance:** given two grant sets, returns added / removed /
  unchanged. Tests cover overlap, scoping differences, wildcard
  collapse.
  **Effort:** S.

### Milestone 0.D — Slot registry skeleton

- [ ] **P0.T10** — `SlotRegistry` core. In-memory pub/sub for slot
  contributions; not wired to the host yet.
  **Where:** `packages/extensions/src/slot-registry.ts`.
  **Depends on:** P0.T4.
  **Acceptance:** `register(extId, contribs)`, `unregister(extId)`,
  `subscribe(slotId, cb)`, `getAll(slotId)`. Tests cover register /
  unregister / composition ordering.
  **Effort:** M.

- [ ] **P0.T11** — `when` clause parser + evaluator (subset for v1
  context keys only).
  **Where:** `packages/extensions/src/when/{parse.ts,eval.ts}`.
  **Depends on:** P0.T1.
  **Acceptance:** parses the v1 expression language from
  `01-extension-model.md §5.1`; evaluates against a `Context` value;
  rejects unknown identifiers. Tests cover boolean ops, comparisons,
  parenthesisation.
  **Effort:** M.

### Milestone 0.E — CLI validate

- [ ] **P0.T12** — Create `packages/extensions-cli/` workspace
  package, wire into `@ifc-lite/cli` unified entry.
  **Where:** `packages/extensions-cli/{package.json,src/index.ts}`,
  `packages/cli/src/commands/ext.ts`.
  **Depends on:** P0.T1.
  **Acceptance:** `ifc-lite ext --help` prints subcommand list.
  **Effort:** S.

- [ ] **P0.T13** — `ifc-lite ext validate <path>` command.
  **Where:** `packages/extensions-cli/src/commands/validate.ts`.
  **Depends on:** P0.T5, P0.T7, P0.T12.
  **Acceptance:** validates manifest + bundle + capabilities; exits 0
  on pass, non-zero on fail; `--json` flag prints structured errors.
  Integration test against good and bad bundles.
  **Effort:** M.

- [ ] **P0.T14** — `ifc-lite ext init <name>` scaffolder. Produces a
  minimal valid bundle.
  **Where:** `packages/extensions-cli/src/commands/init.ts`,
  `packages/extensions-cli/templates/minimal/`.
  **Depends on:** P0.T12, P0.T4.
  **Acceptance:** generates a bundle that `validate` passes.
  **Effort:** M.

### Milestone 0.F — Eval fixtures

- [ ] **P0.T15** — Authoritative manifest examples for tests.
  **Where:** `packages/extensions/test/fixtures/manifests/`.
  **Depends on:** P0.T4.
  **Acceptance:** ≥ 6 valid manifests covering each contribution
  type; ≥ 12 invalid manifests with each error category.
  **Effort:** M.

- [ ] **P0.T16** — "Deliberately broken" bundles for the future
  repair-loop evals.
  **Where:** `packages/extensions/test/fixtures/broken-bundles/`.
  **Depends on:** P0.T15.
  **Acceptance:** ≥ 5 bundles each with one specific failure mode
  (missing capability, undefined entry, malformed widget, banned
  global in code, broken test spec).
  **Effort:** M.

- [ ] **P0.T17** — Eval harness skeleton (executable later by the
  repair loop).
  **Where:** `packages/extensions/test/eval/harness.ts`.
  **Depends on:** P0.T16.
  **Acceptance:** harness loads bundle, runs validator chain,
  records pass/fail per bundle. No LLM yet; just structured output.
  **Effort:** M.

### Phase 0 gate

Before opening Phase 1:

- [ ] All P0 tasks checked.
- [ ] Security review of T7-T9 sign-off.
- [ ] Test coverage ≥ 70% on `@ifc-lite/extensions`.
- [ ] Changeset added, package version bumped to `0.1.0`.

---

## Phase 1 — Save as Tool (2-3 weeks)

Smallest user-visible feature. A saved script becomes a slot-bound,
named, persistent tool. No AI authoring. No new permissions surface.

| Milestone | Tasks | User-visible? |
|---|---|---|
| 1.A IndexedDB store | T1-T3 | No |
| 1.B Loader + activation | T4-T6 | No |
| 1.C Host integration | T7-T9 | Yes |
| 1.D Promote-to-tool UX | T10-T12 | Yes |
| 1.E Review screen | T13-T15 | Yes |
| 1.F Resource caps + audit | T16-T18 | Yes |

### Milestone 1.A — IndexedDB store

- [ ] **P1.T1** — `extensions` and `extension-bundles` object stores
  with schema versioning.
  **Where:** `packages/extensions/src/storage/idb.ts`.
  **Depends on:** P0.T5.
  **Acceptance:** put/get/list/delete; transactional; schema
  versioning with migration hook. Tests using fake-indexeddb.
  **Effort:** M.

- [ ] **P1.T2** — `InstalledExtensionRecord` type and CRUD ops.
  **Where:** `packages/extensions/src/storage/records.ts`.
  **Depends on:** P1.T1.
  **Acceptance:** record carries id, version, bundle hash, granted
  capabilities, enabled flag, install timestamp. Tests cover round-trip.
  **Effort:** S.

- [ ] **P1.T3** — Bundle hashing (SHA-256) + integrity check on load.
  `[security]`
  **Where:** `packages/extensions/src/storage/integrity.ts`.
  **Depends on:** P1.T1.
  **Acceptance:** install records canonical hash; load verifies; on
  mismatch refuses with structured error. Tests cover happy path and
  tamper.
  **Effort:** S.

### Milestone 1.B — Loader + activation

- [ ] **P1.T4** — `ExtensionLoader` — discover installed extensions,
  validate, register contributions.
  **Where:** `packages/extensions/src/host/loader.ts`.
  **Depends on:** P0.T10, P1.T2.
  **Acceptance:** on construct, scans storage, validates each,
  registers contributions with `SlotRegistry`. Failures captured in
  a per-extension status, not thrown. Tests cover good / bad / mixed.
  **Effort:** M.

- [ ] **P1.T5** — Activation event dispatcher. `onStartup`,
  `onCommand:<id>` only in Phase 1.
  **Where:** `packages/extensions/src/host/activation.ts`.
  **Depends on:** P1.T4.
  **Acceptance:** event arrival → activation if not active; dedupe;
  rejection paths logged. Tests with mock command dispatcher.
  **Effort:** M.

- [ ] **P1.T6** — Sandbox wiring. Per-extension QuickJS context with
  capability-scoped `ctx`.
  **Where:** `packages/extensions/src/host/runtime.ts`,
  extends `packages/sandbox/src/bridge.ts`.
  **Depends on:** P0.T7, P1.T5.
  **Acceptance:** activation creates a context, calls `entry.activate(ctx)`
  if present; `ctx` exposes only fields whose capabilities are
  granted. Tests assert grant ↔ ctx-field equivalence.
  **Effort:** L. `[security]`

### Milestone 1.C — Host integration

- [ ] **P1.T7** — Viewer-side `ExtensionHostProvider` React context.
  **Where:** `apps/viewer/src/sdk/ExtensionHostProvider.tsx`.
  **Depends on:** P1.T4.
  **Acceptance:** wraps app; exposes `useExtensions()` hook;
  re-renders on slot registry change. Tests via React Testing Library.
  **Effort:** M.

- [ ] **P1.T8** — Command palette slot wiring.
  **Where:** `apps/viewer/src/components/viewer/CommandPalette.tsx`
  (existing, modify).
  **Depends on:** P1.T7.
  **Acceptance:** palette reads commands from `SlotRegistry`;
  contributed commands appear under category headers; activation on
  invoke. Manual + automated test.
  **Effort:** M. `[ux]`

- [ ] **P1.T9** — Toolbar.right + keybindings slots.
  **Where:** `apps/viewer/src/components/viewer/MainToolbar.tsx`,
  new `apps/viewer/src/hooks/useExtensionKeybindings.ts`.
  **Depends on:** P1.T7.
  **Acceptance:** toolbar shows contributed icon buttons; keybindings
  registered with existing dispatch layer; conflict warning when two
  extensions claim the same key without `when` specificity.
  **Effort:** M. `[ux]`

### Milestone 1.D — Promote-to-tool UX

- [ ] **P1.T10** — Static-analysis capability inference for promoted
  scripts. `[security]`
  **Where:** `apps/viewer/src/lib/scripts/infer-capabilities.ts`.
  **Depends on:** P0.T7.
  **Acceptance:** AST walker over a saved script returns a minimal
  capability set (e.g. detects `bim.viewer.colorize`, `bim.export.csv`,
  no network). Conservative: any uncertainty maps to read-only.
  Tests cover ≥ 20 sample scripts.
  **Effort:** L.

- [ ] **P1.T11** — "Promote to tool" button in `ScriptPanel`.
  **Where:** `apps/viewer/src/components/viewer/ScriptPanel.tsx`.
  **Depends on:** P1.T7, P1.T10.
  **Acceptance:** appears on any saved script with a successful run;
  opens the promote dialog (T12).
  **Effort:** S. `[ux]`

- [ ] **P1.T12** — Promote dialog: name, icon picker (lucide names),
  category, optional hotkey.
  **Where:** `apps/viewer/src/components/extensions/PromoteToolDialog.tsx`.
  **Depends on:** P1.T11.
  **Acceptance:** produces a valid minimum manifest; routes through
  T13 review screen. Tests assert manifest validity post-dialog.
  **Effort:** M. `[ux]`

### Milestone 1.E — Review screen

- [ ] **P1.T13** — Capability review screen component.
  **Where:** `apps/viewer/src/components/extensions/CapabilityReview.tsx`.
  **Depends on:** P0.T8.
  **Acceptance:** renders capabilities with risk badges and plain
  English; shows source preview tab; requires explicit click; typed
  confirmation for red-tier capabilities; cannot be dismissed by
  keyboard escape on red-tier. Visual regression + a11y tests.
  **Effort:** L. `[security]` `[ux]`

- [ ] **P1.T14** — Source preview pane (read-only Monaco-ish view).
  **Where:** `apps/viewer/src/components/extensions/BundlePreview.tsx`.
  **Depends on:** P1.T13.
  **Acceptance:** tabbed view of bundle files; syntax highlighting;
  copy-to-clipboard. Tests cover render.
  **Effort:** M.

- [ ] **P1.T15** — Install / uninstall actions wired to storage.
  **Where:** `apps/viewer/src/services/extension-installer.ts`.
  **Depends on:** P1.T2, P1.T13.
  **Acceptance:** end-to-end install from review screen; uninstall
  removes all traces (storage, slot registrations, capability grants).
  Tests cover both directions.
  **Effort:** M.

### Milestone 1.F — Resource caps + audit

- [ ] **P1.T16** — Per-extension resource budgets in the sandbox.
  `[security]` `[perf]`
  **Where:** extends `packages/sandbox/src/sandbox.ts` with per-context
  memory/cpu limits keyed by extension id.
  **Depends on:** P1.T6.
  **Acceptance:** memory cap, CPU cap, async network budget all
  enforced; runaway extension killed without affecting host or other
  extensions; tests with a deliberately-greedy fixture.
  **Effort:** L.

- [ ] **P1.T17** — Audit log writer.
  **Where:** `packages/extensions/src/audit/log.ts`,
  `apps/viewer/src/components/extensions/AuditLogPanel.tsx`.
  **Depends on:** P1.T2.
  **Acceptance:** append-only ring buffer (default 30 days / 10 MB);
  records install / uninstall / activation / capability grant; UI
  panel exposes export-as-JSON. Tests cover write-then-read.
  **Effort:** M.

- [ ] **P1.T18** — Settings → Extensions page.
  **Where:** `apps/viewer/src/components/viewer/SettingsPage.tsx`
  (extend with new section).
  **Depends on:** P1.T15, P1.T17.
  **Acceptance:** lists installed extensions, capability summary,
  enable/disable toggle, uninstall button, audit log link.
  **Effort:** M. `[ux]`

### Phase 1 gate

- [ ] All P1 tasks checked.
- [ ] Walkthrough demo recorded: chat → script → promote → tool
  visible after reload.
- [ ] Security pair-review of T6, T10, T13, T16.
- [ ] Playwright e2e: end-to-end install / use / uninstall.
- [ ] Changeset bumps `@ifc-lite/extensions` to `0.2.0`.

---

## Phase 2 — AI-authored extensions (4-6 weeks)

The big phase. Mode B authoring with plan-before-code, validation,
dry-run, and the repair loop. Adds the widget DSL renderer.

| Milestone | Tasks | User-visible? |
|---|---|---|
| 2.A Intent classifier + plan card | T1-T4 | Yes |
| 2.B Authoring system prompt | T5-T7 | No |
| 2.C Bundle synthesis | T8-T10 | No |
| 2.D Static validation | T11-T12 | No |
| 2.E Isolated dry-run | T13-T15 | No |
| 2.F Repair loop | T16-T18 | No |
| 2.G Widget DSL renderer | T19-T22 | Yes |
| 2.H Dock slots | T23-T24 | Yes |
| 2.I Mode C fork + diff | T25-T27 | Yes |

### Milestone 2.A — Intent classifier + plan card

- [ ] **P2.T1** — Intent classifier (rule-based; LLM-assisted fallback).
  **Where:** `apps/viewer/src/lib/llm/intent-classifier.ts`.
  **Depends on:** P1 phase gate.
  **Acceptance:** classifies prompts into one-shot / authoring / fork /
  out-of-scope with ≥ 90% precision on a labelled test set.
  **Effort:** M.

- [ ] **P2.T2** — `AuthoringPlan` data model + Zod schema.
  **Where:** `packages/extensions/src/authoring/plan.ts`.
  **Depends on:** P0.T4.
  **Acceptance:** matches RFC §04.4 shape; plan ↔ JSON round-trip
  preserves fidelity; tests on serialisation.
  **Effort:** S.

- [ ] **P2.T3** — Plan card React component (editable structured plan
  in chat).
  **Where:** `apps/viewer/src/components/viewer/chat/PlanCard.tsx`.
  **Depends on:** P2.T2.
  **Acceptance:** renders contributions, capabilities, triggers, tests;
  inline edit for each row; emits updated plan on change. A11y tested.
  **Effort:** L. `[ux]`

- [ ] **P2.T4** — Chat routing: intent → plan generation → plan card.
  **Where:** `apps/viewer/src/components/viewer/ChatPanel.tsx` (modify).
  **Depends on:** P2.T1, P2.T3.
  **Acceptance:** authoring intents render a plan card; user can
  approve / edit / cancel; approval triggers Milestone 2.C.
  **Effort:** M.

### Milestone 2.B — Authoring system prompt

- [ ] **P2.T5** — Schema-to-prompt converter (Zod → readable prompt
  fragment).
  **Where:** `apps/viewer/src/lib/llm/schema-to-prompt.ts`.
  **Depends on:** P0.T4.
  **Acceptance:** produces stable, cache-friendly prompt fragments;
  snapshot tests.
  **Effort:** M.

- [ ] **P2.T6** — Authoring contract prompt section.
  **Where:** `apps/viewer/src/lib/llm/extension-authoring-prompt.ts`.
  **Depends on:** P2.T5.
  **Acceptance:** assembles manifest schema + widget DSL + capability
  catalogue + style rules; cacheable; total fragment ≤ 20k tokens.
  **Effort:** M.

- [ ] **P2.T7** — Prompt caching integration.
  **Where:** modify `apps/viewer/src/lib/llm/stream-client.ts` and
  `stream-direct.ts`.
  **Depends on:** P2.T6.
  **Acceptance:** authoring contract sent with `cache_control` markers;
  cache hits observable in dev logs. Cost test measures the win.
  **Effort:** M. `[perf]`

### Milestone 2.C — Bundle synthesis

- [ ] **P2.T8** — Plan → manifest generation prompt + parser.
  **Where:** `apps/viewer/src/lib/llm/authoring/manifest-step.ts`.
  **Depends on:** P2.T6.
  **Acceptance:** model emits JSON; parser tolerates code fences and
  recovers gracefully; validates immediately with `manifestSchema`.
  Returns structured failure to repair loop.
  **Effort:** M.

- [ ] **P2.T9** — Plan → code generation prompt + parser.
  **Where:** `apps/viewer/src/lib/llm/authoring/code-step.ts`.
  **Depends on:** P2.T6.
  **Acceptance:** generates one module per entry-point declared in the
  manifest; module files placed in the bundle layout; static checks
  pass before handing to dry-run.
  **Effort:** M.

- [ ] **P2.T10** — Plan → widget generation prompt + parser.
  **Where:** `apps/viewer/src/lib/llm/authoring/widget-step.ts`.
  **Depends on:** P2.T6.
  **Acceptance:** generates widget JSON validating against widget DSL
  schema; cross-references commands the manifest declares.
  **Effort:** M.

### Milestone 2.D — Static validation

- [ ] **P2.T11** — AST walker for banned globals + capability
  construction taint. `[security]`
  **Where:** `packages/extensions/src/validate/code.ts`.
  **Depends on:** P0.T7.
  **Acceptance:** rejects `globalThis`, `window`, `process`, `eval`,
  `Function(...)`, dynamic non-bundle imports; flags string
  concatenation that ends up in capability strings. Tests ≥ 25 cases.
  **Effort:** L.

- [ ] **P2.T12** — Cross-reference validator (commands, widgets,
  entry paths, fixtures).
  **Where:** `packages/extensions/src/validate/cross-ref.ts`.
  **Depends on:** P0.T5.
  **Acceptance:** verifies every reference resolves; structured error
  on dangle. Tests on positive and broken bundles.
  **Effort:** M.

### Milestone 2.E — Isolated dry-run

- [ ] **P2.T13** — Sandbox profile: tightened limits for dry-run.
  **Where:** `packages/extensions/src/dryrun/profile.ts`.
  **Depends on:** P1.T16.
  **Acceptance:** 25% mem, 50% cpu of production; configurable; tests
  verify limits propagate to QuickJS runtime.
  **Effort:** S.

- [ ] **P2.T14** — Test runner against canonical fixtures.
  **Where:** `packages/extensions/src/test-runner/index.ts`.
  **Depends on:** P0.T17, P2.T13.
  **Acceptance:** executes manifest-declared tests; checks
  `expect` clauses (mimeType, minBytes, regex, JSON shape).
  Surfaces structured pass/fail.
  **Effort:** L.

- [ ] **P2.T15** — Synthetic fixture support via `bim.create.*`.
  **Where:** `packages/extensions/src/test-runner/synthetic.ts`.
  **Depends on:** P2.T14.
  **Acceptance:** test spec can declare a synthetic-build step; runner
  builds in-memory model before invoking the extension. Tests cover
  a sample synthetic.
  **Effort:** M.

### Milestone 2.F — Repair loop

- [ ] **P2.T16** — Repair controller (orchestrates attempts, budgets).
  **Where:** `apps/viewer/src/lib/llm/authoring/repair-controller.ts`.
  **Depends on:** P2.T11, P2.T12, P2.T14.
  **Acceptance:** drives the validate → dry-run → repair cycle;
  enforces token / time / iteration budgets; structured outcome.
  **Effort:** L.

- [ ] **P2.T17** — Diagnostic shape for the LLM (extends existing
  `script-diagnostics.ts`).
  **Where:** `apps/viewer/src/lib/llm/extension-diagnostics.ts`.
  **Depends on:** P2.T16.
  **Acceptance:** structured diagnostic per failure category; renders
  to a prompt-friendly format; tests cover each category.
  **Effort:** M.

- [ ] **P2.T18** — Authoring telemetry in chat UI (token usage,
  iteration count, time).
  **Where:** modify `apps/viewer/src/components/viewer/ChatPanel.tsx`.
  **Depends on:** P2.T16.
  **Acceptance:** visible counter during authoring; final summary on
  success / failure.
  **Effort:** M. `[ux]`

### Milestone 2.G — Widget DSL renderer

- [ ] **P2.T19** — Widget DSL Zod schema (15 node types per §03).
  **Where:** `packages/extensions/src/widgets/schema.ts`.
  **Depends on:** P0.T1.
  **Acceptance:** schema matches RFC §03.3.1; tests cover each node
  variant + nesting.
  **Effort:** M.

- [ ] **P2.T20** — Widget renderer (React).
  **Where:** `apps/viewer/src/components/extensions/widgets/`
  (one component per node).
  **Depends on:** P2.T19.
  **Acceptance:** every node renders accessibly; data-binding via
  JSONPath-like accessors works; tests for each node + e2e a11y.
  **Effort:** XL. `[a11y]`

- [ ] **P2.T21** — Theming token mapping (variant/tone/density → Tailwind).
  **Where:** `apps/viewer/src/components/extensions/widgets/tokens.ts`.
  **Depends on:** P2.T20.
  **Acceptance:** consistent visuals with rest of viewer; dark mode
  tested.
  **Effort:** M.

- [ ] **P2.T22** — Command dispatch from widgets.
  **Where:** `apps/viewer/src/services/command-dispatcher.ts` (new).
  **Depends on:** P2.T20, P1.T9.
  **Acceptance:** button / interactive nodes invoke commands via
  capability-checked dispatch; tests cover happy + denied path.
  **Effort:** M.

### Milestone 2.H — Dock slots

- [ ] **P2.T23** — `dock.left` `dock.right` `dock.bottom` slot
  containers in viewer layout.
  **Where:** `apps/viewer/src/components/viewer/DockContainer.tsx`
  (new), modify `App.tsx`.
  **Depends on:** P2.T20, P1.T7.
  **Acceptance:** docks render contributed panels; tabs reorderable;
  layout state persists per flavor (placeholder until Phase 3).
  **Effort:** L. `[ux]`

- [ ] **P2.T24** — `contextMenu.entity` + `contextMenu.canvas` slots.
  **Where:** modify `apps/viewer/src/components/viewer/EntityContextMenu.tsx`.
  **Depends on:** P1.T8.
  **Acceptance:** right-click on entity surfaces contributed items
  honoring `when`; tests cover visibility logic.
  **Effort:** M.

### Milestone 2.I — Mode C fork + capability diff

- [ ] **P2.T25** — Fork-and-modify flow in chat.
  **Where:** `apps/viewer/src/lib/llm/authoring/fork.ts`.
  **Depends on:** P2.T16.
  **Acceptance:** loads existing bundle as context; produces a diff
  plan; routes through standard authoring pipeline.
  **Effort:** M.

- [ ] **P2.T26** — Capability diff UI in review screen.
  **Where:** modify `apps/viewer/src/components/extensions/CapabilityReview.tsx`.
  **Depends on:** P0.T9, P1.T13.
  **Acceptance:** "since v1.2 this extension wants" diff list; typed
  confirmation if any new red-tier capability; tests cover all
  category combinations.
  **Effort:** M. `[security]`

- [ ] **P2.T27** — Update flow: install new version, archive old,
  preserve user config.
  **Where:** `apps/viewer/src/services/extension-installer.ts` (extend).
  **Depends on:** P2.T26.
  **Acceptance:** version bump replaces bundle, retains storage and
  config; downgrade-on-failure works (preserved old bundle reactivates
  cleanly). Tests cover happy path and rollback.
  **Effort:** M.

### Phase 2 gate

- [ ] All P2 tasks checked.
- [ ] Authoring success rate ≥ 70% on a labelled benchmark (10
  prompts; bundle installs ≤ 4 repair iterations).
- [ ] Cost regression: typical authoring session ≤ planned budget.
- [ ] Security review of T11, T26.
- [ ] Walkthrough demo: chat → plan → tested bundle → install →
  visible panel.
- [ ] Changeset bumps `@ifc-lite/extensions` to `0.4.0`.

---

## Phase 3 — Flavors (3-4 weeks)

Flavors as a first-class concept. Switchable, exportable, importable,
mergeable.

| Milestone | Tasks | User-visible? |
|---|---|---|
| 3.A Flavor data model + storage | T1-T3 | No |
| 3.B Activation / switching | T4-T6 | Yes |
| 3.C Export | T7-T8 | Yes |
| 3.D Import + diff view | T9-T11 | Yes |
| 3.E Three-way merge UI | T12-T14 | Yes |
| 3.F Migration + safety nets | T15-T17 | Yes |

### Milestone 3.A — Flavor data model

- [ ] **P3.T1** — `Flavor` Zod schema + types per §05.1.
  **Where:** `packages/extensions/src/flavor/schema.ts`.
  **Depends on:** P1.T2.
  **Acceptance:** schema validates; tests for all sub-types.
  **Effort:** M.

- [ ] **P3.T2** — Flavor storage (IndexedDB).
  **Where:** `packages/extensions/src/flavor/storage.ts`.
  **Depends on:** P1.T1, P3.T1.
  **Acceptance:** CRUD; active-flavor pointer; auto-snapshot on change
  (last 10). Tests cover snapshots.
  **Effort:** M.

- [ ] **P3.T3** — Flavor migration scaffold.
  **Where:** `packages/extensions/src/flavor/migrations/`.
  **Depends on:** P3.T1.
  **Acceptance:** v1 no-op migration; tests cover migration chain.
  **Effort:** S.

### Milestone 3.B — Activation / switching

- [ ] **P3.T4** — Flavor switcher (deactivate current, activate new).
  **Where:** `packages/extensions/src/flavor/switcher.ts`.
  **Depends on:** P3.T2, P1.T4.
  **Acceptance:** clean activation/deactivation; UI re-renders;
  failures abort and restore previous flavor. Tests cover happy +
  partial-failure paths.
  **Effort:** L.

- [ ] **P3.T5** — Flavor status indicator in status bar.
  **Where:** modify `apps/viewer/src/components/viewer/StatusBar.tsx`.
  **Depends on:** P3.T4.
  **Acceptance:** shows active flavor name; click opens flavor picker.
  **Effort:** S.

- [ ] **P3.T6** — Settings → Flavors page.
  **Where:** modify `apps/viewer/src/components/viewer/SettingsPage.tsx`.
  **Depends on:** P3.T4.
  **Acceptance:** list flavors, create/rename/duplicate/delete, set
  active. Tests cover each operation.
  **Effort:** M. `[ux]`

### Milestone 3.C — Export

- [ ] **P3.T7** — Flavor bundler (zips full flavor + bundles to
  `.iflv`).
  **Where:** `packages/extensions/src/flavor/bundler.ts`.
  **Depends on:** P3.T1.
  **Acceptance:** produces gzipped JSON with magic header + version;
  decodes round-trip. `--minimal` mode references registry instead of
  inlining (registry resolution stubbed for Phase 5).
  **Effort:** M.

- [ ] **P3.T8** — Export UI + summary view.
  **Where:** `apps/viewer/src/components/extensions/FlavorExport.tsx`.
  **Depends on:** P3.T7.
  **Acceptance:** shows summary before download; supports stripped
  variants. Tests cover summary correctness.
  **Effort:** M. `[ux]`

### Milestone 3.D — Import + diff view

- [ ] **P3.T9** — Flavor unpacker + validator. `[security]`
  **Where:** `packages/extensions/src/flavor/unpacker.ts`.
  **Depends on:** P3.T7.
  **Acceptance:** validates magic, version, schema; rejects mismatch;
  capability list extracted per extension. Tests cover good / corrupt
  / malicious inputs.
  **Effort:** M.

- [ ] **P3.T10** — Diff computer (active flavor vs. incoming).
  **Where:** `packages/extensions/src/flavor/diff.ts`.
  **Depends on:** P3.T9.
  **Acceptance:** structured diff (extensions added / removed /
  changed; capability diffs; lenses; settings). Tests with multiple
  scenarios.
  **Effort:** M.

- [ ] **P3.T11** — Import review screen.
  **Where:** `apps/viewer/src/components/extensions/FlavorImport.tsx`.
  **Depends on:** P3.T10, P1.T13.
  **Acceptance:** renders diff with per-extension capability badges;
  three actions (Apply / Save as new / Merge). Tests cover each.
  **Effort:** L. `[ux]`

### Milestone 3.E — Three-way merge

- [ ] **P3.T12** — Three-way merger.
  **Where:** `packages/extensions/src/flavor/merge.ts`.
  **Depends on:** P3.T10.
  **Acceptance:** resolves extensions / capabilities / lenses /
  keybindings / settings per §05.5; conflict detection structured.
  Tests cover all rule branches.
  **Effort:** L.

- [ ] **P3.T13** — Merge UI (side-by-side diff with per-row checkbox).
  **Where:** `apps/viewer/src/components/extensions/FlavorMergeUI.tsx`.
  **Depends on:** P3.T12.
  **Acceptance:** users can accept / reject each row; result preview
  updates live; tests cover navigate + accept-all + reject-all.
  **Effort:** L. `[ux]`

- [ ] **P3.T14** — Merge commit (write merged flavor; archive prior).
  **Where:** `packages/extensions/src/flavor/merge-commit.ts`.
  **Depends on:** P3.T12.
  **Acceptance:** atomic write; snapshot retains prior; tests cover
  rollback.
  **Effort:** M.

### Milestone 3.F — Migration + safety nets

- [ ] **P3.T15** — Saved-scripts → starter flavor migration.
  **Where:** `apps/viewer/src/services/saved-scripts-migration.ts`.
  **Depends on:** P3.T4.
  **Acceptance:** one-time opt-in dialog; produces a "My scripts"
  flavor with each script as an extension; reversible. Tests cover
  the conversion.
  **Effort:** M. `[ux]`

- [ ] **P3.T16** — Reset-to-defaults panic button.
  **Where:** modify `apps/viewer/src/components/viewer/SettingsPage.tsx`.
  **Depends on:** P3.T4.
  **Acceptance:** restores baseline flavor; archives the previous;
  surfaces in onboarding tour.
  **Effort:** S.

- [ ] **P3.T17** — Safe-mode launch (`?safe=1`, shift-launch on desktop).
  **Where:** modify `apps/viewer/src/main.tsx`,
  `apps/desktop/src-tauri/src/main.rs`.
  **Depends on:** P3.T4.
  **Acceptance:** boots without active flavor; UI banner indicating
  safe mode; tests for both web and desktop.
  **Effort:** M. `[upstream]`

### Phase 3 gate

- [ ] All P3 tasks checked.
- [ ] Export → import → merge cycle works between two browsers.
- [ ] Saved-scripts migration tested with users who have ≥ 5 scripts.
- [ ] Walkthrough demo of flavor share.
- [ ] Changeset bumps `@ifc-lite/extensions` to `0.6.0`.

---

## Phase 4 — Self-improvement loops (4-6 weeks)

Action log + pattern miner + personal memory + SDK-update repair.

| Milestone | Tasks | User-visible? |
|---|---|---|
| 4.A Action log | T1-T3 | Indirect |
| 4.B Pattern miner | T4-T7 | Yes |
| 4.C Suggestion UX | T8-T10 | Yes |
| 4.D Personal prompt overlay | T11-T14 | Yes |
| 4.E SDK-update repair | T15-T18 | Yes |
| 4.F Privacy controls | T19-T21 | Yes |

### Milestone 4.A — Action log

- [ ] **P4.T1** — Action log schema + projection vocabulary.
  **Where:** `packages/extensions/src/log/schema.ts`.
  **Depends on:** none.
  **Acceptance:** intent vocabulary defined; payload schemas exclude
  raw content; tests enforce the no-content rule via static checks.
  **Effort:** M. `[security]`

- [ ] **P4.T2** — Action log writer (append-only ring with byte cap).
  **Where:** `packages/extensions/src/log/writer.ts`.
  **Depends on:** P4.T1.
  **Acceptance:** writes intents; enforces rolling window; export /
  delete. Tests cover overflow.
  **Effort:** M.

- [ ] **P4.T3** — Wire log calls at intent boundaries.
  **Where:** edits across viewer slices (`modelSlice`, `lensSlice`,
  `dataSlice`, `chatSlice`, etc.).
  **Depends on:** P4.T2.
  **Acceptance:** every named intent emits exactly one log line;
  tests assert one-emit-per-intent.
  **Effort:** L.

### Milestone 4.B — Pattern miner

- [ ] **P4.T4** — Sequence miner (PrefixSpan-like, length ≤ 5).
  **Where:** `packages/extensions/src/miner/sequence.ts`.
  **Depends on:** P4.T2.
  **Acceptance:** finds frequent ordered patterns; configurable
  threshold; tests with planted patterns.
  **Effort:** L.

- [ ] **P4.T5** — Scoring function (frequency × recency × diversity).
  **Where:** `packages/extensions/src/miner/score.ts`.
  **Depends on:** P4.T4.
  **Acceptance:** deterministic; ranks expected pattern first on
  planted sets.
  **Effort:** M.

- [ ] **P4.T6** — Filter against installed extensions / saved tools.
  **Where:** `packages/extensions/src/miner/filter.ts`.
  **Depends on:** P4.T5.
  **Acceptance:** removes patterns already covered. Tests cover
  overlap heuristics.
  **Effort:** M.

- [ ] **P4.T7** — Plan-stub generator (pattern → `AuthoringPlan`).
  **Where:** `packages/extensions/src/miner/plan-stub.ts`.
  **Depends on:** P2.T2, P4.T6.
  **Acceptance:** produces a plan that the authoring pipeline accepts
  with minimal edits.
  **Effort:** M.

### Milestone 4.C — Suggestion UX

- [ ] **P4.T8** — Idle scheduler.
  **Where:** `apps/viewer/src/services/miner-scheduler.ts`.
  **Depends on:** P4.T4.
  **Acceptance:** runs miner on idle; throttled; respects power /
  battery hints when available.
  **Effort:** M.

- [ ] **P4.T9** — "Ideas" status bar indicator + panel.
  **Where:** modify `StatusBar.tsx`; new
  `apps/viewer/src/components/extensions/IdeasPanel.tsx`.
  **Depends on:** P4.T8, P4.T7.
  **Acceptance:** quiet, non-modal; one suggestion / session cap;
  "Not now" / "Don't suggest again" honoured. Tests cover lifecycle.
  **Effort:** M. `[ux]`

- [ ] **P4.T10** — Accept-flow: suggestion → authoring pipeline.
  **Where:** `apps/viewer/src/services/suggestion-acceptor.ts`.
  **Depends on:** P4.T7, P2.T16.
  **Acceptance:** seeds the plan card with the stub; user can edit;
  full pipeline runs from there.
  **Effort:** M.

### Milestone 4.D — Personal prompt overlay

- [ ] **P4.T11** — Prompt overlay storage + Zod schema.
  **Where:** `packages/extensions/src/memory/overlay.ts`.
  **Depends on:** P3.T1.
  **Acceptance:** capped at 4000 tokens; round-trip; tests cover cap.
  **Effort:** S.

- [ ] **P4.T12** — System prompt integration.
  **Where:** modify `apps/viewer/src/lib/llm/system-prompt.ts`.
  **Depends on:** P4.T11.
  **Acceptance:** overlay appended; cached separately so cache hits
  survive overlay edits.
  **Effort:** M.

- [ ] **P4.T13** — Memory extractor (post-session chat → proposed
  overlay delta). `[security]`
  **Where:** `apps/viewer/src/lib/llm/memory-extractor.ts`.
  **Depends on:** P4.T12.
  **Acceptance:** runs after long sessions; produces structured
  delta; output filter rejects content-specific entries (file names,
  GlobalIds, PII). Tests cover both planted-preference and
  planted-content cases.
  **Effort:** L.

- [ ] **P4.T14** — Overlay edit UI.
  **Where:** `apps/viewer/src/components/extensions/PromptOverlayEditor.tsx`.
  **Depends on:** P4.T13.
  **Acceptance:** Markdown editor; diff view for proposed deltas;
  accept / edit / reject. A11y tested.
  **Effort:** M. `[ux]`

### Milestone 4.E — SDK-update repair

- [ ] **P4.T15** — SDK-update detector.
  **Where:** `packages/extensions/src/host/sdk-version.ts`.
  **Depends on:** P1.T4.
  **Acceptance:** compares installed extension `engines.ifcLiteSdk`
  against current; produces a list of extensions to re-evaluate.
  **Effort:** S.

- [ ] **P4.T16** — Auto re-run extension tests on update.
  **Where:** `packages/extensions/src/host/sdk-revalidate.ts`.
  **Depends on:** P2.T14, P4.T15.
  **Acceptance:** runs each affected extension's tests; structured
  pass / fail; quiet on pass; queues on fail.
  **Effort:** M.

- [ ] **P4.T17** — Repair-task UI (batch notification + per-extension
  review).
  **Where:** `apps/viewer/src/components/extensions/RepairQueuePanel.tsx`.
  **Depends on:** P4.T16, P2.T16.
  **Acceptance:** one notification for the queue; per-extension diff
  + approve; rollback on repair-failure.
  **Effort:** L. `[ux]`

- [ ] **P4.T18** — CI canary against registry extensions before SDK
  release.
  **Where:** `.github/workflows/sdk-canary.yml`.
  **Depends on:** P4.T16.
  **Acceptance:** runs all registered canary bundles against the
  candidate SDK; blocks release on regression. (Registry not in v1; we
  use a curated set under `tests/extensions/canaries/`.)
  **Effort:** M. `[upstream]`

### Milestone 4.F — Privacy controls

- [ ] **P4.T19** — Settings → Privacy section with action-log
  toggle, export, delete.
  **Where:** modify `SettingsPage.tsx`.
  **Depends on:** P4.T2.
  **Acceptance:** all three actions work; explanatory copy from
  `06-self-improvement.md §7` verbatim.
  **Effort:** M. `[ux]`

- [ ] **P4.T20** — Privacy disclosures in onboarding.
  **Where:** existing onboarding tour (extend).
  **Depends on:** P4.T19.
  **Acceptance:** user sees the privacy summary on first launch
  after Phase 4 ships; can review later.
  **Effort:** S.

- [ ] **P4.T21** — Eval suite for the three loops (per §06.6).
  **Where:** `packages/extensions/test/eval/loops/`.
  **Depends on:** P4.T7, P4.T13, P4.T16.
  **Acceptance:** synthetic logs / transcripts; metrics tracked; CI
  flags regressions.
  **Effort:** L.

### Phase 4 gate

- [ ] All P4 tasks checked.
- [ ] Action log demonstrably contains no model / chat / file content.
- [ ] Pattern miner suggests a planted pattern in a fresh user
  simulation.
- [ ] Memory extractor evals pass at the targeted thresholds.
- [ ] SDK-bump dry run: representative installed-extension set passes
  with the repair loop fixing ≥ 80% of failures.
- [ ] Changeset bumps `@ifc-lite/extensions` to `0.9.0`.

---

## Phase 5 — Sharing infrastructure (open-ended)

Hosted URLs, signing, registry. Decision gate: ≥ 50 flavors exported
in the wild and ≥ 10 distinct authors before starting.

Sketches only; we will write a dedicated implementation plan when this
phase opens.

- [ ] **P5.T1** — Hosted flavor URL service (server endpoint).
  `[upstream]`
- [ ] **P5.T2** — Ed25519 signing for bundles. `[security]`
- [ ] **P5.T3** — Registry CI suite (validate, capability hygiene,
  test pass, lint, license check).
- [ ] **P5.T4** — Public listing UI.
- [ ] **P5.T5** — Reporting + takedown flow.
- [ ] **P5.T6** — Kill-switch list integration.
- [ ] **P5.T7** — Aggregate-stats pipeline (install count, weekly
  active; no per-user data).

Bump `@ifc-lite/extensions` to `1.0.0` when this phase ships.

---

## Quality gates (apply to every phase)

These are non-negotiable per the cross-cutting workstreams. Each phase
gate above includes them; this section is the single source of truth.

- [ ] **Tests:** new code coverage ≥ 70%; e2e Playwright for any
  user-visible change.
- [ ] **Types:** no `as any`, no `@ts-ignore` (per AGENTS.md §7).
- [ ] **A11y:** keyboard navigation + screen reader pass on new UI.
- [ ] **Security:** any `[security]` task pair-reviewed against
  threat model.
- [ ] **Perf:** any `[perf]` task ships measurements.
- [ ] **Docs:** guide updates for user-visible behaviour.
- [ ] **Changeset:** added for any `packages/*` change.

## Definition of done (per task)

A task is done when:

1. Code is merged to main.
2. Tests for the task are in the repo and pass.
3. Documentation (guide / RFC update) is in the repo.
4. The acceptance criterion is demonstrably met (recording or test).
5. Any follow-up items are filed as separate issues, linked.

## Update protocol for this document

- Edit in-place; check boxes on commit.
- Add a `Notes:` line under any task that diverged from the original
  plan, explaining the divergence.
- When a phase ships, append a "Retrospective" subsection summarising
  what changed vs. the plan and what we learned.
- Never renumber tasks.
