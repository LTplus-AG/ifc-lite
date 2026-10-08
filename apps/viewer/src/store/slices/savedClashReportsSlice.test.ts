/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The saved clash report library when its rules cannot be loaded (#6947). The
 * validator and the save rules are a chunk the viewer fetches on demand, and a
 * fetch can fail. The library must then end in a state it can leave again, not
 * stay "loading": every saved content library that is loading disables
 * "Download library backup" for all of them.
 *
 * The slice is loaded inside the tests: it does not exist without this
 * feature, and an absent module must read as a failed assertion, not as a test
 * file that never ran.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { contentTransaction, readContentRows, transactionDone } from '@/lib/storage/content-database';
import type { ContentKind } from '@/lib/storage/content-kinds';

const KIND = 'clashReports' as ContentKind;
const report = {
  version: 1, id: 'clash-report-stored', name: 'Stored run', savedAt: '2026-10-07T09:30:00.000Z',
  run: { settings: { tolerance: 0.002, excludeVoidsAndHosts: true }, rules: [], mutationRevision: 0 },
  models: [{ id: 'm1', name: 'A.ifc', sourceFingerprint: 'revision-1' }],
  completeness: { stale: false, excluded: 0 }, grouping: null, clashes: [],
} as const;

async function slice() {
  const module = await import('./savedClashReportsSlice.js').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(module, 'saved clash reports exist (#6947)');
  return module;
}

async function storeRow(): Promise<void> {
  const tx = await contentTransaction('items', 'readwrite'), done = transactionDone(tx);
  tx.objectStore('items').put({ kind: KIND, id: report.id, version: 1, revision: 1, createdAt: 1, modifiedAt: 1, deleted: false, payload: report });
  await done;
}

describe('Saved clash report library when its rules cannot be loaded (#6947)', () => {
  it('is not left loading, refuses edits without throwing, and reads the library on the next open', async () => {
    const { savedClashReportsSlice } = await slice();
    assert.equal(typeof savedClashReportsSlice, 'function', 'the slice takes the loader of its rules');
    await storeRow();
    const real = (await import('@/lib/clash/saved-report-persistence')).loadClashReportLibrary;
    let online = false;
    const store = create(savedClashReportsSlice(() => online ? real() : Promise.reject(new Error('Failed to fetch dynamically imported module'))));

    // Whether the stored row can be read here depends on whether an earlier test in this process already loaded
    // the validator, so the outcome asserted is the one that holds either way: opening settles, and not on "loading".
    await store.getState().initializeSavedClashReports();
    assert.notEqual(store.getState().savedClashReportsStorage.phase, 'loading', 'the library is not left loading');
    assert.equal(await store.getState().saveClashReport({ ...report, id: 'clash-report-new', models: [...report.models], run: { ...report.run, rules: [] }, clashes: [] }), false,
      'a save is refused, as a failed write is, rather than rejecting with nothing shown');
    assert.equal(await store.getState().renameSavedClashReport(report.id, 'Renamed'), false);
    assert.equal(await store.getState().deleteSavedClashReport(report.id), false);
    assert.deepEqual((await readContentRows(KIND)).map((row) => [row.id, row.deleted, (row.payload as { name: string }).name]), [[report.id, false, 'Stored run']],
      'nothing stored was touched');

    online = true;
    assert.equal(await store.getState().initializeSavedClashReports(), true, 'opening again, as the dialog does, reads the library once the rules load');
    assert.deepEqual([store.getState().savedClashReportsStorage.phase, store.getState().savedClashReports.map((entry) => entry.name)], ['ready', ['Stored run']]);
  });
});
