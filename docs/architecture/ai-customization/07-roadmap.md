# 07 — Roadmap, Metrics, and Open Questions

## 1. Phases

Five phases. Each delivers user value on its own; nothing is held
hostage by a later phase. Estimated effort is wall-clock for a small
team (1–2 engineers), not pessimistic ranges.

### Phase 0 — Foundations (1–2 weeks)

Goal: scaffold the new package and the manifest, with no UI changes.

- Create `@ifc-lite/extensions` package, MPL-2.0 headers, baseline tests.
- Land the `ExtensionManifest` Zod schema (v1).
- Land the capability grammar + parser.
- Land the `SlotRegistry` skeleton (no host integration yet).
- Land the bundle layout walker and a CLI `ifc-lite ext validate`.
- Write the first "deliberately broken" eval fixture set.

Definition of done: a manifest validates, capabilities parse, the CLI
returns a structured error on bad inputs, and there are tests for all
the above.

### Phase 1 — Save as Tool (2–3 weeks)

Goal: turn a saved script into a slot-bound, named, persistent tool.
No AI authoring; no new permissions surface. The smallest feature
that proves the model.

- IndexedDB stores for installed extensions.
- Loader + activation events: `onStartup`, `onCommand:<id>`.
- Slot bindings for `commandPalette`, `toolbar.right`, `keybindings`.
- "Promote to tool" action in `ScriptPanel`.
- Capability inference from `script-preflight` static analysis;
  default to `model.read` + `viewer.read`.
- Per-extension review screen with capabilities and source preview.
- Resource caps (memory, CPU, network=0 by default).
- Audit log entries for install / uninstall / activation.

Definition of done: a user can promote a saved script to a toolbar
button + command-palette entry, reload the page, and find it still
there. Uninstall removes it cleanly. Capability mismatch fails closed.

### Phase 2 — AI-authored extensions (4–6 weeks)

Goal: full Mode B authoring with plan-before-code, dry-run, repair
loop.

- New AI authoring path in `ChatPanel`: intent classifier + plan card.
- New system-prompt section: "Authoring contract" + manifest schema
  + widget DSL + capability catalogue.
- Generation pipeline: plan → bundle → static validate → dry-run →
  repair loop → review screen.
- Declarative widget DSL renderer (`Stack`, `Text`, `Field`, `Button`,
  `Table`, `KeyValueGrid`, `EmptyState`, `Spinner`, `ErrorBanner`).
- `dock.right`, `dock.left`, `dock.bottom` slot integrations.
- Test runner against canonical fixtures + synthetic-fixture support.
- Repair-loop budget instrumentation (tokens, time, attempts).
- Capability diff flow for updates.
- Mode C (fork & modify) flow.

Definition of done: a user can describe an extension in chat, see a
plan, approve it, see a tested bundle, and install it. The same flow
upgrades an existing extension and shows a capability diff.

### Phase 3 — Flavors (3–4 weeks)

Goal: flavors as a first-class concept — switchable, exportable,
importable, mergeable.

- `Flavor` data model + IndexedDB storage.
- Flavor activation / switching with full lifecycle.
- Flavor export to `.iflv` with summary.
- Flavor import with diff view and per-extension review.
- Three-way merge UI.
- Migration tool: saved scripts → starter flavor.
- Reset-to-defaults panic button.
- Safe-mode launch (`?safe=1` and shift-launch).

Definition of done: a user can export a flavor, share the file with a
colleague, the colleague imports it with a review screen, picks
"merge," resolves conflicts, and ends with a working composite flavor.

### Phase 4 — Self-improvement loops (4–6 weeks)

Goal: pattern mining + memory + SDK-update auto-repair.

- Action log: stores, projections, rolling window enforcement.
- Pattern miner: idle scheduler, sequence/conditional mining, scoring,
  filtering, top-K selection.
- Suggestion UX in status bar + suggestions panel.
- Personal prompt overlay: settings UI, memory extractor, diff-accept
  flow, output filter.
- SDK-update extension re-evaluation + repair queue.
- Privacy disclosures, logging-off toggle, log export/delete.

Definition of done: a user who repeats a pattern receives a suggestion;
opt-out is honoured; SDK upgrade triggers automatic test runs for
installed extensions and queued repair for failures.

### Phase 5 — Sharing infrastructure (open-ended)

Hosted flavor URLs, signing, registry. We treat this as a separate
product decision and not part of the core v1.

- Server endpoint for hosted flavor publish/fetch.
- Ed25519 signing for bundles.
- Registry CI (validate, capability hygiene, test pass).
- Public listing UI.
- Reporting + takedown flow.

Decision gate before starting Phase 5: at least 50 flavors exported
in the wild and at least 10 distinct authors. Build for demand, not
for ambition.

## 2. Success metrics

What we measure to know whether this works. Numbers are illustrative;
we will set targets before each phase.

| Phase | Metric | Why we care |
|---|---|---|
| 1 | % of users with ≥ 1 promoted tool after 30 days | Proves "save as tool" is useful, not just a feature pile-on. |
| 1 | Median lifetime of a promoted tool | Tools should outlast a single session. |
| 2 | Authoring success rate (plan → installable bundle ≤ N attempts) | Direct quality measure of the AI pipeline. |
| 2 | Repair-loop iterations median / p95 | Cost and latency signal. |
| 2 | % of authored extensions still working after one SDK release | Drift resistance. |
| 2 | Capability distribution of authored extensions (read-only / mutate / network) | Detect creep toward over-broad caps. |
| 3 | Flavor exports per active user / week | Sharing actually happening. |
| 3 | Median # of extensions per active flavor | Composition is the model. |
| 4 | Suggestion accept rate | Pattern miner relevance. |
| 4 | % of installed extensions that pass tests after each SDK release | Self-healing fidelity. |
| 4 | Memory-overlay edit rate after AI-suggested deltas | User trust in suggested updates. |

Telemetry that drives these is **opt-in** and aggregate-only. The user
can see what we collect (a settings page lists every metric and a
sample payload) and turn it off.

## 3. Risks and how we address them

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Capability creep: extensions converge on `*` patterns | Medium | High | Capability catalogue review every quarter; reject in registry CI; risk badges visible to user. |
| AI-authored extensions silently rot on SDK changes | High | Medium | SDK-update test pass + repair loop; metric in §2. |
| Permission-prompt fatigue | Medium | Medium | One review screen per install, never repeat for unchanged caps. |
| Performance regressions from many extensions | Medium | Medium | Per-extension resource caps; unhealthy-shutoff. |
| Cross-extension interference | Low | High | One sandbox per extension; command-invoke requires capability intersection. |
| Flavor merge produces unusable state | Medium | Medium | Auto-snapshot, safe-mode, reset-to-defaults. |
| BYOK key exfiltration via extension | Low (by design) | Critical | OCAP design; no bridge method returns keys; audit reviews ensure this. |
| Malicious community flavor / extension (Phase 5) | Medium | High | Signing, CI scans, takedown, kill-switch list, capability review on every install. |
| Privacy regression in action log | Low | Critical | Intent-only logging; no content; eval set blocks regressions. |
| Authoring cost explodes (token budgets) | Medium | Low | Per-session budget; estimate shown before plan approval. |
| Pattern miner becomes annoying | Low | Medium | One suggestion per session cap; honour-immediately for opt-out. |
| Manifest schema churn breaks installed extensions | Low | High | SemVer manifest version; migration functions; archive pre-migration bundle. |
| UI redress (extension mimics system dialog) | Low | High | Inalienable slot frames + dialog branding; no modal dialogs from extensions. |
| Cross-realm bug in QuickJS bridge | Low | Critical | Bridge tests assert grant ↔ ctx-field equivalence; fuzz over capability strings. |

## 4. Explicit non-goals

These come up repeatedly when describing the system; we are saying no
to each.

- **A marketplace with payments.** Out of scope. If the community
  wants it later, it is a separate product.
- **Generative UI in JSX.** No. Declarative DSL only.
- **Self-modifying host code at runtime.** No. The AI does not rewrite
  the React app; the AI authors extensions that sit on top.
- **Cross-user pattern aggregation.** No. The pattern miner is
  on-device; we do not learn from cohorts.
- **Cloud sync of flavors by default.** No. Flavors are local; export
  is opt-in; hosted URLs (Phase 4+) are opt-in.
- **Automatic installation of suggested extensions.** No. Suggestions
  always pass through the review screen.
- **Trusted extension tier.** No. Every extension runs in QuickJS.
- **Replacing `ScriptPanel` or `ChatPanel`.** No. The new authoring
  flow is parallel; both existing paths continue to work.

## 5. Open questions

These are the genuine open design questions we expect to resolve
during implementation. They are tracked separately as issues; this
list is the spec-level summary.

1. **Embedded view escape hatch.** Will any extension we want to ship
   require an iframe? If so, what is the message-bridge contract?
   Defer until we hit a real case.
2. **Inter-extension communication.** Is `command.invoke:*` the right
   primitive, or do we want a publish/subscribe channel? Lean toward
   command invocation only in v1.
3. **Extension-supplied themes.** Should the widget DSL support theme
   tokens beyond `variant`/`tone`? Probably not in v1.
4. **Server-side activations.** Do server triggers need a different
   manifest section, or do we infer activation events that work
   server-side from the existing catalogue? Lean toward inference.
5. **LLM as a capability (`ctx.llm`).** Do extensions get access to a
   metered LLM through the bridge, or do they bring their own? Defer
   until Phase 4. Need a token budget model first.
6. **Test fixture authoring.** Do AI-authored extensions need a way to
   produce new canonical fixtures, or do they synthesise them with
   `bim.create.*` at test time? Lean synth in v1.
7. **Public registry's monetization stance.** Free + sponsored?
   Donations? Foundation-run? Punt to Phase 5.
8. **Mobile / embed surface.** Embed SDK and (hypothetical) mobile
   need to render the widget DSL too. Out of scope for v1; called out
   so the DSL design considers it.
9. **Extension localization beyond English.** Manifest supports
   `l10n` from day one; do we ship localized capability descriptions?
   Lean yes; small effort.
10. **Recovery model for the corrupt-flavor case.** Auto-snapshots cover
    most cases. Do we need a "bootable" minimal flavor that is part of
    the host build? Probably yes for safe-mode.

## 6. What success looks like

If this system works, in 12 months we see:

- The "average user" has between 2 and 6 installed extensions, half of
  them their own creation or a colleague's flavor.
- The most-installed community extensions cover use cases we never
  shipped first-party — discipline-specific lenses, exporters to
  workflow tools the team uses, audit dashboards.
- A user who picks up IFClite for the first time can describe a tool
  they want, see a plan, accept it, and have a working extension in
  under five minutes.
- When the SDK ships a breaking change, < 5% of installed extensions
  break for users, and of those, the repair loop handles ≥ 80%
  without user code intervention.
- Zero security incidents we did not preview in the threat model.

If this system fails, we expect to see:

- Capability creep (everyone wants `*`).
- Authoring quality decays as the surface grows.
- Pattern miner suggestions ignored.
- Flavors imported once, forgotten.

We instrument for both shapes from day one.

## 7. What to read next

- [`README.md`](./README.md) — overall index.
- [`00-overview.md`](./00-overview.md) — vision and prior art.
- Each `0N-*.md` document — design detail for that domain.

When the design is approved, the next document we write is an
implementation tracking issue in `.github/` with the Phase 0 task
list.
