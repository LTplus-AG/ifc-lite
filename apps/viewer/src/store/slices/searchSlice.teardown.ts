/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The search slice's contribution to viewer-state teardown.
 *
 * A sibling module rather than a block at the bottom of `searchSlice.ts`
 * because that file is 388 lines and the ~400-line module rule
 * (`scripts/check-module-size.mjs`) leaves no room for a 13-key table with its
 * comments. The seam is real either way: this answers "what does search
 * destroy under a scope", which is a different question from "how does search
 * behave", has different rules (pure, no `set`/`get`), and is reviewed on its
 * own — `owns` is the list of everything search is willing to throw away.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';
import { emptyFilterState } from './searchSlice.js';

/**
 * What a session reset clears on the search slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "Search - results reference the previous model's expressIds, drop them."
 *
 * Two fields are deliberately absent from `owns`, matching today's reset:
 *
 *  - `searchModalTab` is remembered across opens (the slice's own doc says
 *    so). A file swap is not the user changing tabs.
 *  - `searchFilterAutoRunPending` is a one-shot hand-off armed by another
 *    panel ("Create filter from this Hierarchy node") and consumed by the
 *    Filter tab on its next render. `resetViewerState` has never touched it,
 *    and clearing it here would silently swallow a run the user just asked
 *    for when the hand-off crosses a load.
 */
export const searchTeardown = defineSliceTeardown(
  'searchSlice',
  [
    'searchQuery',
    'searchOpen',
    'searchHighlightIndex',
    'searchIndexes',
    'searchVimCycle',
    'searchModalOpen',
    'searchFieldFilter',
    'searchModelFilter',
    'searchFilterResult',
    'searchFilterRunning',
    'searchFilterError',
    'searchFilter',
    'searchFilterSchema',
  ],
  {
    'session-reset': () => ({
      // The inline field: query, popover and the frozen vim-cycle
      // snapshot. `resetSearch()` clears exactly these four for Esc; it
      // stays a separate, narrower action (see `searchSlice.ts`).
      searchQuery: '',
      searchOpen: false,
      searchHighlightIndex: 0,
      searchVimCycle: null,
      // Tier-1 indexes are built per model and keyed by modelId; the
      // incoming file rebuilds its own.
      searchIndexes: new Map(),
      // The advanced modal: closed, with its chip filters back at the
      // slice's defaults ('all' fields, all models included).
      searchModalOpen: false,
      searchFieldFilter: 'all' as const,
      searchModelFilter: null,
      // Filter run state — the rows are the outgoing model's express ids.
      searchFilterResult: null,
      searchFilterRunning: false,
      searchFilterError: null,
      // The rules themselves name storeys / types / property values
      // discovered in the outgoing model, so they go back to the slice's
      // own empty state rather than being re-pointed at the new file.
      searchFilter: emptyFilterState(),
      // Per-model chip-dropdown schema cache, keyed by modelId.
      searchFilterSchema: new Map(),
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
