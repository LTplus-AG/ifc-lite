/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { click, render, waitFor } from '@/test/render';
import { button, realComparison, setupReportDeletionFixtures } from '@/test/report-deletion-fixture';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';

setupReportDeletionFixtures();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** Open the real preview with the store's delete action replaced by a held one. */
async function openPreview(held: Promise<boolean>) {
  const report = await realComparison();
  let calls = 0;
  useViewerStore.setState({ deleteSavedComparison: () => { calls += 1; return held; } });
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = report.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const begin = button(ui, 'Delete saved comparison'); assert.ok(begin); click(begin);
  await waitFor(() => button(ui, 'Delete report')?.disabled === false, 'preview is ready for reviewed deletion');
  return { ui, calls: () => calls };
}
// Dispatch directly: a double-click's second press can arrive before React re-renders.
const press = (node: Element) => act(() => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

test('C-9 a double-clicked Delete report runs one removal pass and disables Keep while it is in flight', async () => {
  const pending = deferred<boolean>();
  const { ui, calls } = await openPreview(pending.promise);
  const confirm = button(ui, 'Delete report')!;
  press(confirm);
  press(confirm);
  await waitFor(() => calls() > 0, 'the first press reaches the removal action');
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
  assert.equal(calls(), 1, 'the second press is refused while the first removal is in flight');
  assert.equal(button(ui, 'Keep')?.disabled, true, 'Keep is disabled while the removal is in flight');
  await act(async () => { pending.resolve(true); await pending.promise; });
});

test('C-9 a rejected removal is reported and releases busy so Keep works again', async () => {
  const pending = deferred<boolean>();
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const { ui, calls } = await openPreview(pending.promise);
    click(button(ui, 'Delete report')!);
    await waitFor(() => calls() === 1, 'the removal action is in flight');
    await act(async () => { pending.reject(new Error('removal exploded')); await pending.promise.catch(() => undefined); });
    await waitFor(() => button(ui, 'Keep')?.disabled === false, 'a rejected removal cannot leave Keep disabled');
    assert.ok(warn.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('removal exploded'))), 'the rejection is logged, not swallowed');
  } finally { warn.mock.restore(); }
});
