---
"@ifc-lite/extensions": minor
---

Library-layer ground for Phase 2 / Phase 3 / Phase 4.

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
