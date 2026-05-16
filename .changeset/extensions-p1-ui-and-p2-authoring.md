---
"@ifc-lite/extensions": minor
---

Phase 1 UI finish + Phase 2 authoring kernel + Phase 4 integration.

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
