/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When finishing a report deletion throws in the host's callback, the message
 * must match what actually happened: a removal that failed says it could not
 * be removed, never that it "was removed". The host callback is a prop, so
 * stubbing it to throw is a fair behaviour test. Plain-value assertions only.
 */

import '@/test/setup-dom.js';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { click, render, waitFor } from '@/test/render';
import { button, realComparison, setupReportDeletionFixtures } from '@/test/report-deletion-fixture';
import { ReportDeletionPreview } from '../ReportDeletionPreview';

setupReportDeletionFixtures();

test('a removal that failed, whose storage-failure callback throws, says the report could not be removed', async () => {
  const report = await realComparison();
  const errors: string[] = [];
  mock.method(toast, 'error', (message: unknown) => { errors.push(String(message)); return ''; });
  mock.method(console, 'error', () => undefined);
  mock.method(console, 'warn', () => undefined);
  try {
    useViewerStore.setState({ deleteSavedComparison: async () => false });
    let storageFailedCalls = 0;
    const ui = render(<ReportDeletionPreview source={{ kind: 'compare', id: report.id }} report={report} onCancel={() => {}}
      storageFailed={() => { storageFailedCalls++; throw new Error('the host could not mark storage as failed'); }} />);
    await waitFor(() => button(ui, 'Delete report')?.disabled === false, 'preview is ready for reviewed deletion');
    click(button(ui, 'Delete report')!);
    await waitFor(() => errors.length > 0, 'the failure is reported');
    assert.equal(storageFailedCalls, 1);
    assert.deepEqual([...errors], ['The report could not be removed. Close and reopen this view, then try again.']);
    assert.equal(useViewerStore.getState().savedComparisons.some(row => row.id === report.id), true, 'nothing was removed');
  } finally {
    mock.restoreAll();
  }
});
