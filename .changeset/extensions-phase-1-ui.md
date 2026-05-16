---
"@ifc-lite/extensions": minor
---

Viewer UI integration for the extension system (Phase 1 UI batch).

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
