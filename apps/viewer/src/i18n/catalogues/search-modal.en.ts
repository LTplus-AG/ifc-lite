/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Search Modal / Search Inline catalogue (#4918 slice). Covers the
 * modal SHELL (`SearchModal.tsx`), the Search tab's chip filters, result
 * list and footer actions (`SearchModal.text.tsx`), the Filter tab's run
 * bar / result table / error box (`SearchModal.filter.tsx`), and the
 * always-visible toolbar field (`SearchInline.tsx`). The chip-editing
 * builder itself is the sibling `search-filters.en.ts` (split purely to
 * stay under module-size budgets; both share the `searchModal.*` prefix).
 *
 * GlobalIds, IFC type names and entity/property/model NAMES stay literal
 * throughout — they are model content the search surfaces read, not view
 * chrome. `ListDefinition`'s default `name: 'Filter result'` and its
 * seeded column `label`s ('Name', 'Class') are likewise left as literal
 * defaults: like a saved BCF topic title or a default document name
 * elsewhere in this sweep, they become persisted, user-renamable DATA the
 * moment `handleCreateList` runs, not on-screen-only copy.
 */
export const searchModalEn = {
  // ── SearchModal.tsx (shell) ──────────────────────────────────────────
  'searchModal.shell.title': 'Advanced Search',
  'searchModal.shell.searchTab': 'Search',
  'searchModal.shell.filterTab': 'Filter',
  'searchModal.shell.escKey': 'Esc',
  'searchModal.shell.closeHint': 'close',
  'searchModal.shell.searchPlaceholder': 'Search GUID, name, type, description, objectType…',
  'searchModal.shell.searchAriaLabel': 'Advanced search query',

  // ── SearchModal.text.tsx (Search tab) ────────────────────────────────
  'searchModal.text.fieldLabel': 'Field:',
  'searchModal.text.fieldAll': 'All',
  'searchModal.text.fieldName': 'Name',
  'searchModal.text.fieldType': 'Type',
  'searchModal.text.fieldGuid': 'GUID',
  'searchModal.text.fieldDescription': 'Description',
  'searchModal.text.fieldObjectType': 'ObjectType',
  'searchModal.text.modelsLabel': 'Models:',
  'searchModal.text.resetModelFilter': 'reset',
  'searchModal.text.resultsAriaLabel': 'Search results',
  'searchModal.text.emptyPrompt': 'Start typing to search — GlobalIds, names, IFC types, descriptions.',
  'searchModal.text.noMatches': 'No results match the active filters. Clear chips to widen the search.',
  'searchModal.text.toggleRowAriaLabel': 'Toggle {name} in selection',
  'searchModal.text.unnamed': 'unnamed',
  'searchModal.text.resultCount': { one: '{count} result', other: '{count} results' },
  'searchModal.text.ofTotal': '(of {total})',
  'searchModal.text.selectedCount': '· {count} selected',
  'searchModal.text.frameTitle': 'Frame primary selection',
  'searchModal.text.frameLabel': 'Frame',
  'searchModal.text.selectAllTitle': 'Add all {count} results to multi-selection',
  'searchModal.text.selectAllLabel': 'Select all',
  'searchModal.text.clearSelectionTitle': 'Clear multi-selection',
  'searchModal.text.clearSelectionLabel': 'Clear',

  // ── SearchModal.filter.tsx (Filter tab run bar / result table) ───────
  'searchModal.filterRun.noRulesError': 'Add at least one rule before running.',
  'searchModal.filterRun.nothingToIsolate': 'Nothing to isolate — every matched row belongs to a model that is no longer loaded.',
  'searchModal.filterRun.isolationCleared': 'Isolation cleared — showing the full model.',
  'searchModal.filterRun.isolatingLimited': 'Isolating the first {limit} matches — the filter hit its row limit.',
  'searchModal.filterRun.noModelLoaded': "Load an IFC file first — the filter runs against the active model's data.",
  'searchModal.filterRun.scannedCount': 'scanned {count}',
  'searchModal.filterRun.limitedToTitle': 'Increase the limit or narrow the rules to see more matches',
  'searchModal.filterRun.limitedToBadge': 'limited to {limit}',
  'searchModal.filterRun.timingSummary': '⏱ {runMs} ms · {rows} rows',
  'searchModal.filterRun.createListTitle': 'Freeze these results into a new list',
  'searchModal.filterRun.createListLabel': 'Create list',
  'searchModal.filterRun.isolateTitle': 'Isolate these results in the 3D view',
  'searchModal.filterRun.isolateLabel': 'Isolate in 3D',
  'searchModal.filterRun.exportTitle': 'Export results',
  'searchModal.filterRun.exportLabel': 'Export',
  'searchModal.filterRun.downloadCsv': 'Download CSV',
  'searchModal.filterRun.downloadJson': 'Download JSON',
  'searchModal.filterRun.cancel': 'Cancel',
  'searchModal.filterRun.runTitleReady': 'Run the filter against every loaded model',
  'searchModal.filterRun.runTitleDisabled': 'Add a rule first',
  'searchModal.filterRun.run': 'Run',
  'searchModal.filterRun.multiModelNote':
    'Filtering across all {count} loaded models. Click any row to select that element in the right model.',
  'searchModal.filterRun.filterFailed': 'Filter failed',
  'searchModal.filterRun.addRulesPrompt': 'Add rules and click Run.',
  'searchModal.filterRun.noMatches': '0 matches — broaden the rules, lower the limit, or try OR.',

  // ── SearchInline.tsx (always-visible toolbar field) ──────────────────
  'searchModal.inline.searchPlaceholder': 'Search GUID, name, type… ( / )',
  'searchModal.inline.searchAriaLabel': 'Search entities',
  'searchModal.inline.clearFiltersAriaLabel': 'Clear filters',
  'searchModal.inline.advancedFilter': 'Advanced filter',
  'searchModal.inline.advancedFilterActiveAriaLabel': 'Advanced filter — {count} active',
  'searchModal.inline.advancedFilterTitle': 'Advanced filter (⌘⇧F)',
  'searchModal.inline.cyclingPrefix': 'cycling ',
  'searchModal.inline.cyclingPressHint': ' — press ',
  'searchModal.inline.cycleNextKey': 'n',
  'searchModal.inline.cyclePrevKey': 'N',
  'searchModal.inline.exitCycleAriaLabel': 'Exit cycle',
  'searchModal.inline.recentSearches': 'Recent searches',
  'searchModal.inline.clearRecents': 'Clear',
  'searchModal.inline.indexingHint': {
    one: 'Indexing {count} model… results appear as rows become searchable.',
    other: 'Indexing {count} models… results appear as rows become searchable.',
  },
  'searchModal.inline.selectorSyntaxHint':
    'That reads as selector syntax. This box searches names, IFC types and GlobalIds — run a selector from the Filter tab (Advanced, below).',
  'searchModal.inline.noResultsHint': 'No results — try a name, IFC type, or full GlobalId.',
  'searchModal.inline.unnamed': 'unnamed',
  'searchModal.inline.resultCountHint': {
    one: '{count} result · ↑↓ · ↵ · ⇧↵ · Esc',
    other: '{count} results · ↑↓ · ↵ · ⇧↵ · Esc',
  },
  'searchModal.inline.indexingCountHint': '· indexing {count}…',
  'searchModal.inline.advanced': 'Advanced',
} satisfies Record<string, TranslationValue>;
