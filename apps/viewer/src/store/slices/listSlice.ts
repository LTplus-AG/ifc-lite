/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List state slice - configurable property tables from IFC data
 */

import type { StateCreator } from 'zustand';
import type { ListDefinition, ListResult } from '@ifc-lite/lists';
import { loadListDefinitions, saveListDefinitionsResult } from '../../lib/lists/persistence.js';
import { defineSliceTeardown } from '../teardown.js';
import type { VisibilityOwnership } from '../../lib/visibility/ownership.js';

export interface ListSlice {
  // State
  listDefinitions: ListDefinition[];
  /** Last successfully loaded/saved native rows, independent of unsaved edits. */
  listDefinitionSource: ListDefinition[];
  activeListId: string | null;
  listResult: ListResult | null;
  listPanelVisible: boolean;
  listExecuting: boolean;
  /** Message from the most recent execution or import failure (e.g. a name
   *  pattern column `compileNameMatcher` rejected as unsafe), or `null` when
   *  there is none to show. Distinct from an empty `listResult` — a genuinely
   *  empty result set is not an error and must never populate this field. */
  listError: string | null;
  /** A list definition handed off from elsewhere (e.g. "Create list" in the
   *  search filter) for the ListPanel to open straight into the builder. */
  pendingListDraft: ListDefinition | null;
  /** The panel's claim on the isolate / ghost channel from a group row's
   *  Isolate / X-ray context action (#6368), released only if still owned. */
  listVisibilityOwned: VisibilityOwnership;

  // Actions
  setListDefinitions: (definitions: ListDefinition[]) => boolean;
  addListDefinition: (definition: ListDefinition) => void;
  updateListDefinition: (id: string, updates: Partial<ListDefinition>) => void;
  deleteListDefinition: (id: string) => void;
  setActiveListId: (id: string | null) => void;
  setListResult: (result: ListResult | null) => void;
  setListPanelVisible: (visible: boolean) => void;
  toggleListPanel: () => void;
  setListExecuting: (executing: boolean) => void;
  setListError: (error: string | null) => void;
  setPendingListDraft: (definition: ListDefinition | null) => void;
}

export const createListSlice: StateCreator<ListSlice, [], [], ListSlice> = (set, get) => {
  const initial = loadListDefinitions();
  return {
  // Initial state - load saved definitions
  listDefinitions: initial,
  listDefinitionSource: structuredClone(initial),
  activeListId: null,
  listResult: null,
  listPanelVisible: false,
  listExecuting: false,
  listError: null,
  pendingListDraft: null,
  listVisibilityOwned: null,

  // Actions
  setListDefinitions: (listDefinitions) => {
    const saved = saveListDefinitionsResult(listDefinitions);
    if (!saved.ok) { set({ listError: saved.message }); return false; }
    set({ listDefinitions, listDefinitionSource: structuredClone(listDefinitions), listError: null });
    return true;
  },

  addListDefinition: (definition) => {
    const updated = [...get().listDefinitions, definition];
    set({ listDefinitions: updated });
    const saved = saveListDefinitionsResult(updated);
    set({ listError: saved.ok ? null : saved.message,
      ...(saved.ok ? { listDefinitionSource: structuredClone(updated) } : {}) });
  },

  updateListDefinition: (id, updates) => {
    const updated = get().listDefinitions.map(d =>
      d.id === id ? { ...d, ...updates, updatedAt: Date.now() } : d
    );
    set({ listDefinitions: updated });
    const saved = saveListDefinitionsResult(updated);
    set({ listError: saved.ok ? null : saved.message,
      ...(saved.ok ? { listDefinitionSource: structuredClone(updated) } : {}) });
  },

  deleteListDefinition: (id) => {
    const updated = get().listDefinitions.filter(d => d.id !== id);
    const activeListId = get().activeListId === id ? null : get().activeListId;
    const listResult = get().activeListId === id ? null : get().listResult;
    set({ listDefinitions: updated, activeListId, listResult });
    const saved = saveListDefinitionsResult(updated);
    set({ listError: saved.ok ? null : saved.message,
      ...(saved.ok ? { listDefinitionSource: structuredClone(updated) } : {}) });
  },

  setActiveListId: (activeListId) => set({ activeListId }),
  setListResult: (listResult) => set({ listResult }),
  setListPanelVisible: (listPanelVisible) => set({ listPanelVisible }),
  toggleListPanel: () => set((state) => ({ listPanelVisible: !state.listPanelVisible })),
  setListExecuting: (listExecuting) => set({ listExecuting }),
  setListError: (listError) => set({ listError }),
  setPendingListDraft: (pendingListDraft) => set({ pendingListDraft }),
  };
};

/**
 * What a session reset clears on the list slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "Lists - reset result but keep definitions (user's saved lists)"
 *
 * `listDefinitions` is the user's authored work and round-trips to
 * localStorage, so it is absent from `owns` — this slice is not willing to
 * destroy it. `pendingListDraft` is absent for the same reason no teardown
 * path touches it today: it is a hand-off in flight from another panel, and
 * clearing it here would drop a list the user just asked to build.
 */
export const listTeardown = defineSliceTeardown(
  'listSlice',
  ['listPanelVisible', 'activeListId', 'listResult', 'listExecuting', 'listVisibilityOwned'],
  {
    'session-reset': () => ({
      listPanelVisible: false,
      activeListId: null,
      // The rows reference the OUTGOING model's entities; the user re-runs
      // the definition against the new one.
      listResult: null,
      listExecuting: false,
      // The claim names the outgoing model's renderer ids (#6368).
      listVisibilityOwned: null,
    }),
    // Keep the claim on what survives, in the same patch that prunes the
    // channel, so the list still owns (and can release) the rest (#6368).
    'model-removed': ({ isStale }, state) => {
      const owned = state.listVisibilityOwned;
      if (!owned) return {};
      const ids = new Set([...owned.ids].filter((id) => !isStale(id)));
      if (ids.size === owned.ids.size) return {};
      return { listVisibilityOwned: ids.size > 0 ? { channel: owned.channel, ids } : null };
    },
    'all-models-cleared': () => ({ listVisibilityOwned: null }),
  },
);
