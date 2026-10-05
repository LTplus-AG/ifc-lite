/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import './setup-dom.js';
import 'fake-indexeddb/auto';
import { beforeEach, mock } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { clashGroupLibrary, useClashGroupLibrary, DEFAULT_GROUP_WORKSPACE } from '@/lib/clash/group-workspace';
import { bcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { bcfOutboxLibrary } from '@/lib/bcf-publication/outbox-store';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { clashGroupApplicationLibrary } from '@/lib/clash/group-applications';
import { waitFor } from './render.js';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { createValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import { createSavedComparisonsSlice } from '@/store/slices/savedComparisonsSlice';
import { contentTransaction, transactionDone, requestValue, type RecoveryRow } from '@/lib/storage/content-database';

export async function clearContentDatabase(): Promise<void> {
  const tx = await contentTransaction(['items', 'migrations', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  for (const name of ['items', 'migrations', 'recovery']) tx.objectStore(name).clear();
  await done;
}

/** Inspect committed migration originals without the later backup feature (#6679). */
export async function readPreservedContent(): Promise<RecoveryRow[]> {
  const tx = await contentTransaction('recovery', 'readonly');
  const done = transactionDone(tx);
  const request = requestValue(tx.objectStore('recovery').getAll()) as Promise<RecoveryRow[]>;
  const [rows] = await Promise.all([request, done]);
  return rows;
}

/** Refuse real database write transactions, rather than mocking the saved result. */
export function refuseContentWrites(name = 'QuotaExceededError') {
  const original = IDBDatabase.prototype.transaction;
  return mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readwrite' && (typeof stores === 'string' ? stores === 'items' : stores.includes('items'))) {
      throw new DOMException('Storage refused transaction', name);
    }
    return original.call(this, stores, mode, options);
  });
}

/** Wait for these staged report writes, including later saves beside already committed rows. */
export async function waitForValidationReportsCommit(): Promise<void> {
  const ids = useViewerStore.getState().savedValidationReports.map(entry => entry.id);
  await waitFor(() => ids.length > 0 && ids.every(id => useViewerStore.getState().validationReportsStorage.items[id] === 'saved'),
    'staged validation report writes must commit before durable reads');
}

/** Fresh library controllers and transactions for mounted persistence tests (#6679). */
beforeEach(async () => {
  await act(async () => {
    const previous = useViewerStore.getState();
    await Promise.all([previous.retryDocumentsSave(), previous.retryValidationReportsSave(), previous.retrySaveComparisons()]);
    await clearContentDatabase();
    localStorage.removeItem('ifc-lite-documents');
    localStorage.removeItem('ifc-lite-validation-reports-v1');
    localStorage.removeItem('ifc-lite-saved-comparisons');
    localStorage.removeItem('ifc-lite-clash-manual-groups');
    await clashGroupLibrary.restore();
    await Promise.all([bcfDraftLibrary.restore(), bcfOutboxLibrary.restore(), modelChangeLibrary.restore(), clashGroupApplicationLibrary.restore()]);
    useClashGroupLibrary.setState({ activeId: DEFAULT_GROUP_WORKSPACE });
    useViewerStore.setState({
      ...createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
      ...createValidationReportsSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
      ...createSavedComparisonsSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
    });
    const state = useViewerStore.getState();
    await Promise.all([state.initializeDocuments(), state.initializeValidationReports(), state.initializeSavedComparisons()]);
  });
});
