/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List state slice - configurable property tables from IFC data
 */

import type { StateCreator } from 'zustand';
import type { ListDefinition, ListResult } from '@ifc-lite/lists';
import { loadListDefinitions, saveListDefinitions } from '../../lib/lists/persistence.js';

export interface ListSlice {
  // State
  listDefinitions: ListDefinition[];
  activeListId: string | null;
  listResult: ListResult | null;
  listPanelVisible: boolean;
  listExecuting: boolean;
  /** A list definition handed off from elsewhere (e.g. "Create list" in the
   *  search filter) for the ListPanel to open straight into the builder. */
  pendingListDraft: ListDefinition | null;

  // Actions
  setListDefinitions: (definitions: ListDefinition[]) => void;
  addListDefinition: (definition: ListDefinition) => void;
  updateListDefinition: (id: string, updates: Partial<ListDefinition>) => void;
  deleteListDefinition: (id: string) => void;
  setActiveListId: (id: string | null) => void;
  setListResult: (result: ListResult | null) => void;
  setListPanelVisible: (visible: boolean) => void;
  toggleListPanel: () => void;
  setListExecuting: (executing: boolean) => void;
  setPendingListDraft: (definition: ListDefinition | null) => void;
}

export const createListSlice: StateCreator<ListSlice, [], [], ListSlice> = (set, get) => ({
  // Initial state - load saved definitions
  listDefinitions: loadListDefinitions(),
  activeListId: null,
  listResult: null,
  listPanelVisible: false,
  listExecuting: false,
  pendingListDraft: null,

  // Actions
  setListDefinitions: (listDefinitions) => {
    set({ listDefinitions });
    saveListDefinitions(listDefinitions);
  },

  addListDefinition: (definition) => {
    const updated = [...get().listDefinitions, definition];
    set({ listDefinitions: updated });
    saveListDefinitions(updated);
  },

  updateListDefinition: (id, updates) => {
    const updated = get().listDefinitions.map(d =>
      d.id === id ? { ...d, ...updates, updatedAt: Date.now() } : d
    );
    set({ listDefinitions: updated });
    saveListDefinitions(updated);
  },

  deleteListDefinition: (id) => {
    const updated = get().listDefinitions.filter(d => d.id !== id);
    const activeListId = get().activeListId === id ? null : get().activeListId;
    const listResult = get().activeListId === id ? null : get().listResult;
    set({ listDefinitions: updated, activeListId, listResult });
    saveListDefinitions(updated);
  },

  setActiveListId: (activeListId) => set({ activeListId }),
  setListResult: (listResult) => set({ listResult }),
  setListPanelVisible: (listPanelVisible) => set({ listPanelVisible }),
  toggleListPanel: () => set((state) => ({ listPanelVisible: !state.listPanelVisible })),
  setListExecuting: (listExecuting) => set({ listExecuting }),
  setPendingListDraft: (pendingListDraft) => set({ pendingListDraft }),
});
