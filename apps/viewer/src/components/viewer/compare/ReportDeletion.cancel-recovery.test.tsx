/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { click, render, waitFor } from '@/test/render';
import { readContentRows, writeContent } from '@/lib/storage/content-database';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';
import { detectCoincidentWalls, mountClashPanel, saveCurrentResultAs } from '@/test/clash-report-fixture';
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


test('#7245 Keep recovers an actual mounted native clash report after quota-refused deletion without Retry or reload', async () => {
  mountClashPanel(); await detectCoincidentWalls(2);
  const report = await saveCurrentResultAs('Native clash quota Keep recovery');
  assert.equal(report.clashes.length, 1, 'actual parsed native walls produce the stored clash');
  const row = document.body.querySelector(`[data-clash-report="${report.id}"]`); assert.ok(row);
  const remove = button(row, 'Delete'); assert.ok(remove); click(remove);
  await waitFor(() => button(row, 'Delete report')?.disabled === false, 'actual native preview becomes ready');
  const beforeModels = useViewerStore.getState().models;
  const beforeVersion = useViewerStore.getState().mutationVersion;
  const refused = refuseContentWrites();
  try {
    click(button(row, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedClashReportsStorage.items[report.id] === 'quota', 'actual database refuses the own tombstone');
    await waitFor(() => button(row, 'Keep')?.disabled === false, 'quota failure completes before Keep');
    const durable = (await readContentRows('clashReports')).find(entry => entry.id === report.id);
    assert.ok(durable && !durable.deleted);
    assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(report)));
    assert.equal(useViewerStore.getState().savedClashReports.some(entry => entry.id === report.id), false, 'own staged tombstone is genuinely pending');
  } finally { refused.mock.restore(); }
  click(button(row, 'Keep')!);
  await waitFor(() => document.body.querySelector('[data-report-deletion-preview]') === null, 'Keep closes the actual mounted preview');
  await waitFor(() => useViewerStore.getState().savedClashReports.some(entry => entry.id === report.id), 'Keep recovers the native clash source without Retry or reload');
  assert.deepEqual(useViewerStore.getState().savedClashReports.find(entry => entry.id === report.id), report);
  assert.ok(document.body.querySelector(`[data-clash-report="${report.id}"]`), 'recovered native report is immediately visible');
  const durable = (await readContentRows('clashReports')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted);
  assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(report)));
  assert.equal(useViewerStore.getState().models, beforeModels);
  assert.equal(useViewerStore.getState().mutationVersion, beforeVersion);
});

function refuseNativeRecoveryReads() {
  const original = IDBDatabase.prototype.transaction;
  return mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readonly') throw new DOMException('Actual cancellation recovery read refusal', 'UnknownError');
    return original.call(this, stores, mode, options);
  });
}

test('#7245 quota Keep retains read-only recovery after actual database read failure until explicit Retry', async () => {
  const { report, ui } = await refusedNativeDeletion();
  const refused = refuseNativeRecoveryReads();
  try {
    click(button(ui, 'Keep')!);
    await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'unavailable', 'actual native recovery read fails');
    assert.equal(useViewerStore.getState().savedComparisons.some(entry => entry.id === report.id), false, 'failed read cannot fabricate the original as authoritative');
  } finally { refused.mock.restore(); }
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), true, 'Retry reads the one revoked source instead of deleting it');
  assert.ok(useViewerStore.getState().savedComparisons.some(entry => entry.id === report.id));
  const durable = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted); assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(report)));
});

test('#7245 direct native revocation inside an always-true approval callback blocks the queued write', async () => {
  const report = await realComparison();
  const original = (await readContentRows('comparison')).find(entry => entry.id === report.id); assert.ok(original);
  let revokeOnCheck = false, cancellation: Promise<boolean> | undefined;
  const guard = () => {
    if (revokeOnCheck) {
      revokeOnCheck = false;
      cancellation = useViewerStore.getState().cancelSavedComparisonDeletion(report.id, guard);
    }
    return true;
  };
  const writes = refuseContentWrites();
  try { assert.equal(await useViewerStore.getState().deleteSavedComparison(report.id, guard), false); }
  finally { writes.mock.restore(); }
  assert.equal(useViewerStore.getState().savedComparisonsStorage.items[report.id], 'quota');
  revokeOnCheck = true;
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), false, 'revocation wins even though the approval callback returns true');
  assert.ok(cancellation, 'the actual queued native pre-write guard requested revocation');
  assert.equal(await cancellation, true);
  const durable = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted); assert.equal(durable.revision, original.revision, 'revocation prevents the actual native write');
  assert.deepEqual(durable.payload, JSON.parse(JSON.stringify(report)));
});


test('#7252 a replacement staged during awaited native deletion approval survives an always-true callback', async () => {
  const report = await realComparison();
  const original = (await readContentRows('comparison')).find(entry => entry.id === report.id); assert.ok(original);
  let entered = false;
  let resume = () => {};
  const pendingApproval = new Promise<void>(resolve => { resume = resolve; });
  const guard = async () => { entered = true; await pendingApproval; return true; };
  const deletion = useViewerStore.getState().deleteSavedComparison(report.id, guard);
  await waitFor(() => entered, 'real native pre-write approval is awaiting');
  const replacement = { ...report, name: 'Replacement staged during awaited approval' };
  try { useViewerStore.getState().stageComparison(replacement); }
  finally { resume(); }
  assert.equal(await deletion, false, 'the old callback cannot authorize its tombstone after a newer native generation');
  const durable = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(durable && !durable.deleted);
  assert.equal(durable.revision, original.revision, 'awaited approval never wrote the revoked tombstone');
  assert.deepEqual(durable.payload, original.payload);
  assert.equal(useViewerStore.getState().savedComparisons.find(entry => entry.id === report.id)?.name, replacement.name);
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), true);
  const committed = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(committed && !committed.deleted);
  assert.deepEqual(committed.payload, JSON.parse(JSON.stringify(replacement)), 'the replacement persists through the canonical library after the old writer exits');
});
