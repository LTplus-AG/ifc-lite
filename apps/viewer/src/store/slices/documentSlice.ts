/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { DocumentSpec } from '@/lib/document/types';
import { documentContent } from '../../lib/document/persistence.js';
import type { ContentCommitReceipt } from '@/lib/storage/content-library';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '@/lib/storage/content-library';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export interface DocumentSlice {
  documents: DocumentSpec[];
  documentsStorage: ContentStatus;
  initializeDocuments: () => Promise<boolean>;
  refreshDocuments: (committed?: readonly ContentCommitReceipt[]) => Promise<boolean>;
  restoreDocuments: () => Promise<boolean>;
  retryDocumentsSave: () => Promise<boolean>;
  activeDocumentId: string | null;
  documentPanelVisible: boolean;
  upsertDocument: (document: DocumentSpec) => Promise<boolean>;
  stageDocument: (document: DocumentSpec) => void;
  deleteDocument: (id: string) => Promise<boolean>;
  setActiveDocumentId: (id: string | null) => void;
  setDocumentPanelVisible: (visible: boolean) => void;
}

export const createDocumentSlice: StateCreator<DocumentSlice, [], [], DocumentSlice> = (set, get) => {
  const library = createContentLibrary(documentContent, () => get().documents, (entries, status) => set({ documents: entries, documentsStorage: status }));
  return {
    documents: [], documentsStorage: initialContentStatus(), activeDocumentId: null, documentPanelVisible: false,
    initializeDocuments: library.initialize, refreshDocuments: library.refresh, retryDocumentsSave: library.retry,
    restoreDocuments: library.restore,
    stageDocument: entry => { const document = documentContent.decode(entry); if (document) library.stage(document.id, document); },
    upsertDocument: document => library.put(document.id, document),
    deleteDocument: id => {
      if (get().activeDocumentId === id) set({ activeDocumentId: null });
      return library.put(id, null);
    },
    setActiveDocumentId: activeDocumentId => set({ activeDocumentId }),
    setDocumentPanelVisible: documentPanelVisible => set({ documentPanelVisible }),
  };
};

export const documentTeardown = defineSliceTeardown(
  'documentSlice',
  ['documentPanelVisible'],
  {
    'session-reset': () => ({ documentPanelVisible: false }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
