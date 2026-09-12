/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Documents panel state (#4594): the saved documents (templates over the
 * model), which one is open, and whether the panel is showing.
 *
 * Documents persist like dashboards (localStorage) and survive every
 * teardown — they are templates, and a new model is exactly when they are
 * re-opened. Only the panel's visibility is session state.
 */
import type { StateCreator } from 'zustand';
import type { DocumentSpec } from '@/lib/document/types';
import { loadDocuments, saveDocuments } from '../../lib/document/persistence.js';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export interface DocumentSlice {
  documents: DocumentSpec[];
  activeDocumentId: string | null;
  documentPanelVisible: boolean;

  /** `false` when the change is in memory but could not be persisted. */
  upsertDocument: (document: DocumentSpec) => boolean;
  deleteDocument: (id: string) => boolean;
  setActiveDocumentId: (id: string | null) => void;
  setDocumentPanelVisible: (visible: boolean) => void;
}

export const createDocumentSlice: StateCreator<DocumentSlice, [], [], DocumentSlice> = (set, get) => ({
  documents: loadDocuments(),
  activeDocumentId: null,
  documentPanelVisible: false,

  upsertDocument: (document) => {
    const current = get().documents;
    const index = current.findIndex((d) => d.id === document.id);
    const documents = index === -1 ? [...current, document] : current.map((d, i) => (i === index ? document : d));
    set({ documents });
    return saveDocuments(documents);
  },
  deleteDocument: (id) => {
    const documents = get().documents.filter((d) => d.id !== id);
    set({ documents, activeDocumentId: get().activeDocumentId === id ? null : get().activeDocumentId });
    return saveDocuments(documents);
  },
  setActiveDocumentId: (activeDocumentId) => set({ activeDocumentId }),
  setDocumentPanelVisible: (documentPanelVisible) => set({ documentPanelVisible }),
});

export const documentTeardown = defineSliceTeardown(
  'documentSlice',
  ['documentPanelVisible'],
  {
    'session-reset': () => ({ documentPanelVisible: false }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
