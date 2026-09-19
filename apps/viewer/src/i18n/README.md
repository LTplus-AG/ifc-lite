# Viewer localization

English is the in-tree fallback. Feature catalogues live in `catalogues/` and
are composed in `en.ts`; keep them bounded to one user-facing feature instead
of growing a single catalogue file.

Translations must preserve every named parameter in their English template.
Callers pass formatted display values, while translators control word order,
punctuation, spacing, and unit placement. Use complete messages for states
rather than assembling translated fragments, lowercasing labels, or appending
suffixes. Missing keys fall back to English; an explicit empty string remains
empty.

The Section-tool catalogue contains 69 strings covering the mounted 3D
Section subtree: plane controls and state messages, cap styling, visualization
badges and the drag-gizmo tooltip, plus the two entry labels that open a 2D
drawing. It deliberately does not cover the drawing panel, toolbar, tours,
number formatting, or locale persistence. Locales registered in tests exercise
fallback and live catalogue replacement; they are not languages shipped by
the viewer.

## Adding a locale

Add one file, `locales/<tag>.ts`, named by its BCP 47 tag (`de.ts`,
`pt-BR.ts`), that default-exports a partial catalogue:

```ts
import type { Catalogue } from '../registry';

export default {
  'ribbon.tab.home': 'Start',
  'appearanceAssignmentList.summaryProducts': { one: '{count} Objekt', other: '{count} Objekte' },
} satisfies Catalogue;
```

No viewer code changes. `locales.boot.ts` discovers the file as a lazy chunk,
and the viewer picks a locale from `?lang=<tag>` (remembered in
`localStorage` under `ifc-lite:locale`; `?lang=en` switches back), then the
remembered choice, then the browser's languages (`de-CH` matches `de`), then
English. `<html lang>` follows the active locale.

`catalogue-problems.test.ts` loads every file in `locales/` and fails on keys
that no longer exist, dropped or renamed placeholders, and plural messages
without `other`; the same problems are logged in the browser console when the
locale loads. Untranslated keys fall back to English one by one, so a partial
locale is valid.

## Coverage

The ribbon toolbar catalogue covers the default toolbar's own chrome: tab
strip, group names, button labels, tooltips and aria-labels on all six tabs,
and the ribbon switch notice. Labels owned by shared registries (camera
commands, exporters, extension panels), the classic `MainToolbar`, and the
rest of the viewer's panels and dialogs are not converted yet.

The main-toolbar catalogue (#4918 slice 1) covers the classic single-strip
`MainToolbar`'s own chrome: file operations, the Panels/Edit-properties/View
options menus' own labels, tool buttons, the selection action cluster, and
the meta cluster (theme, info). It deliberately does not cover the shared
command surfaces the ribbon also renders — camera commands, the export menu,
workspace-panel toggle lists, and the class-visibility body — those are
slice 2 of the #4918 sweep.

The shared-commands catalogue (#4918 slice 2) covers the command lists both
`MainToolbar` and the ribbon render from: the export registry
(`export-commands.ts`, rendered by `ClassicExportMenuItems` /
`RibbonExportGroup`), the camera command registry (`camera-commands.ts`,
rendered by `CameraCommandMenuItems` / `ViewTab`), the bottom-panel and
author-panel toggle lists (`BottomPanelMenuItems`, `AuthorPanelMenuItems`),
and the class-visibility dropdown body (`ClassVisibilityMenuContent`). The
two data-only registries carry a translation key per row rather than calling
`t()` themselves (no React import), the same pattern `sectionConstants.ts`'s
`AXIS_INFO` uses; their renderers call `t(row.xKey)`. It deliberately does
not cover the command palette (`CommandPalette.tsx`, ~745 lines / 84
literals — sized for its own slice) or extension-contributed labels
(`extension.label`, sourced from the extension registry, not a literal) —
those remain for a later slice of the #4918 sweep.

The command-palette catalogue (#4918 slice 3) covers the Ctrl/Cmd+K palette's
static command labels, its browse-mode category headers, and its own chrome
(search placeholder, empty state, footer hints). The command TABLE itself
was split out of `CommandPalette.tsx` into `commandPaletteCommandsCore.ts` /
`commandPaletteCommandsPanels.ts` (data + `labelKey` rows, no `t()` call of
their own — same pattern as slice 2's registries) so the component stays
under its module-size budget. Recent-file names, script-template labels,
tour titles, and extension-contributed labels stay uncatalogued, same
reasoning as slice 2: each is runtime content, not a literal in this repo.

The Measure tool catalogue (#4918 slice 6, tools) covers `MeasurePanel.tsx`,
`MeasureQuantities.tsx`, `MeasurePointReadout.tsx`, `MeasurementVisuals.tsx`,
and the shared georeferenced readout `measure-modes/geo-readout.tsx`
(`measure.en.ts`). Measurement unit *symbols* (`m`, `m²`, `mm`, `°`) stay
literal in these files by this slice's own scope, distinct from the gate's
allowlist. The Space Sketch tool catalogue (`space-sketch.en.ts`) covers
`SpaceSketchOverlay.tsx` and its `space-sketch/` popovers, canvas, and
reopen pill. The wall-split tool catalogue (`split-tool.en.ts`) covers
`SplitNumericInput.tsx` and `SplitOverlay.tsx`. `SectionPanel.tsx`'s one
remaining literal was added to the existing `section-tool.en.ts` catalogue
rather than a new file.

Slice 5 (#4918) covers `mcp/**`, `sources/**`, `tours/**`, the components
root, and `ui/` (a companion slice covers `extensions/**`):

- `mcp.en.ts` / `mcp-playground.en.ts` cover the `/mcp` landing page and
  playground's own chrome (hero copy, playground shell, chat UI). Chat
  transcript content and tool-call output are runtime data, not covered.
  `playground-dispatcher.ts` (module-size allowlisted) was not touched.
- `sources.en.ts` covers the Cloud Sources panel across all ten
  `sources/` components. Real file/folder/project names from a connected
  source stay as interpolation params, never literal text.
- `tours.en.ts` covers the tour UI's own chrome (Learn tab, per-panel
  launcher, prerequisite card, first-run invite, step card controls).
  `tour.title` / `description` / `step.title` / `step.body` /
  `step.action.label` come from `TOUR_REGISTRY` (`@/lib/tours/registry`,
  outside this slice) — authored tour content, not UI copy in these
  components, so they are deliberately NOT catalogued, same reasoning as
  the command-palette catalogue's tour entries.
- `viewer-shell.en.ts` covers the components root's `ChunkErrorBoundary`
  fallback and the shared `ui/dialog.tsx` primitive's sr-only close label.

**The sweep's ending gate:** `scripts/check-i18n-literals.mjs` walks the
TypeScript AST of every `apps/viewer/src/components/**/*.tsx` file for
hardcoded JSX text, `{'…'}`-wrapped JSX-expression string literals, and
`aria-label`/`title`/`placeholder`/`alt` string-literal attributes —
skipping IFC EXPRESS names, an explicit technical-acronym allowlist, and
short symbol/unit clusters (`⌘Z`, `m²`) — and ratchets a per-file count in
`scripts/i18n-literals-baseline.json` (wired into `pnpm lint` and CI's
node-tests job): a file's count may never rise above its baseline row,
and a fall also fails until `node scripts/check-i18n-literals.mjs --update` re-records it (a ratchet in both directions).
