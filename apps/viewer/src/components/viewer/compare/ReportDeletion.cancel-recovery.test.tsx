/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { click, render, waitFor } from '@/test/render';
import { readContentRows, writeContent } from '@/lib/storage/content-database';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';
import { button, realComparison, setupReportDeletionFixtures } from '@/test/report-deletion-fixture';

setupReportDeletionFixtures();

async function refusedNativeDeletion() {
  const report = await realComparison();
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = report.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const begin = button(ui, 'Delete saved comparison'); assert.ok(begin); click(begin);
  await waitFor(() => button(ui, 'Delete report')?.disabled === false, 'actual native source is ready for reviewed deletion');
  const refused = refuseContentWrites();
  try {
    click(button(ui, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'quota', 'actual database transaction refuses the staged native deletion');
    await waitFor(() => button(ui, 'Keep')?.disabled === false, 'quota refusal completes before Cancel');
    const row = (await readContentRows('comparison')).find(entry => entry.id === report.id);
    assert.ok(row && !row.deleted, 'actual durable native report survives quota refusal');
    assert.deepEqual(row.payload, JSON.parse(JSON.stringify(report)), 'quota refusal has not replaced the native source');
    assert.equal(useViewerStore.getState().savedComparisons.some(entry => entry.id === report.id), false, 'the actual own tombstone is staged before testing recovery');
    return { report, ui, row };
  } finally { refused.mock.restore(); }
}

test('#7245 quota-refused own deletion displays storage pending rather than a replaced native report', async () => {
  const { ui } = await refusedNativeDeletion();
  const preview = ui.querySelector('[data-report-deletion-preview]'); assert.ok(preview);
  assert.doesNotMatch(preview.textContent ?? '', /report changed or was replaced/i, 'an own quota tombstone is not an external source replacement');
  assert.match(preview.textContent ?? '', /storage/i, 'the preview must explain its actual storage-pending state');
  assert.match(preview.textContent ?? '', /pending|failed|full|unavailable/i);
});

test('#7245 Keep immediately recovers an actual quota-refused native report without manual Retry or reload', async () => {
  const { report, ui } = await refusedNativeDeletion();
  click(button(ui, 'Keep')!);
  await waitFor(() => ui.querySelector('[data-report-deletion-preview]') === null, 'Cancel closes the actual mounted preview');
  await waitFor(() => useViewerStore.getState().savedComparisons.some(entry => entry.id === report.id), 'Cancel recovers the native source without a storage Retry or reload');
  assert.deepEqual(useViewerStore.getState().savedComparisons.find(entry => entry.id === report.id), report);
  assert.ok([...ui.querySelectorAll('option')].some(option => option.value === report.id), 'the recovered report is immediately selectable');
  const durable = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted); assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(report)));
});

test('#7245 quota Cancel recovery cannot overwrite a newer durable native replacement', async () => {
  const { report, ui, row } = await refusedNativeDeletion();
  const replacement = { ...report, name: 'Actual other-tab replacement after quota refusal' };
  const written = await writeContent('comparison', report.id, replacement, row.revision);
  assert.equal(written.ok, true, 'independent native CAS writes the replacement before Cancel');
  click(button(ui, 'Keep')!);
  await waitFor(() => ui.querySelector('[data-report-deletion-preview]') === null, 'Cancel completes the mounted owner lifecycle');
  // Read the actual committed record: optimistic original restoration must not authorize a later stale write.
  const durable = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted); assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(replacement)));
  const current = useViewerStore.getState().savedComparisons.find(entry => entry.id === report.id);
  if (current) assert.deepEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(replacement)), 'Cancel cannot resurrect a cloned stale original as the authoritative current source');
});
