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
