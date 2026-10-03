/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { installResizablePanelLayout } from '@/test/dom-layout.js';
import { after, afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, click, mouseDown, render, type as typeInput, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from './ValidationPanel.js';

after(installResizablePanelLayout());

// This proves resize controls and checklist behavior, not browser layout.
// #6690's scroll reachability needs native-browser evidence with built CSS.
const checklist = {
  version: 1,
  name: 'Coordination checks',
  groups: Array.from({ length: 12 }, (_, index) => ({
    id: `group-${index}`, name: `Review ${index + 1}`,
    items: [{ id: `check-${index}`, text: `Confirm delivery ${index + 1}` }],
  })),
};
const initial = useViewerStore.getState();

beforeEach(() => {
  localStorage.clear();
  // The content fixture owns the current async storage controllers (#6679).
  useViewerStore.setState({ manualChecklist: null, manualAnswers: {}, manualSaveError: null });
  setValidationSourceChoice('manual');
});
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial);
  setValidationSourceChoice(null);
});

it('keeps an empty checklist editor unsplit and preserves drafting when its first group is added (#6690)', () => {
  const ui = render(<ValidationPanel />);
  const button = (label: string) => {
    const found = [...ui.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
    assert.ok(found);
    return found;
  };
  click(button('New checklist'));
  assert.equal(ui.querySelector('[data-validation-results-split]'), null);
  click(button('Add group'));
  assert.ok(ui.querySelector('[role="separator"][aria-label="Resize validation summary"]'));
  click(button('Add check'));
  const input = ui.querySelector<HTMLInputElement>('input[aria-label="What was checked"]');
  assert.ok(input);
  assert.equal(ui.querySelectorAll('[data-testid="manual-check-edit"]').length, 1);
  typeInput(input, 'Check the final delivery');
  click(button('Done editing'));
  assert.equal(ui.querySelectorAll('[data-testid="manual-check-edit"]').length, 0);
  const completedDraft = ui.querySelector('[data-testid="manual-check"]');
  assert.ok(completedDraft?.textContent?.includes('Check the final delivery'));
});

for (const modelCount of [1, 2]) {
  it(`keyboard resizing preserves the final manual check and tab state with ${modelCount} model(s) (#6690)`, async () => {
    const models = Array.from({ length: modelCount }, (_, index) => ({
      ...fixtureModel(`m${index}`), sourceFingerprint: `fingerprint-${index}`,
    }));
    useViewerStore.setState(fixtureModels(...models));
    const ui = render(<ValidationPanel />);
    const input = ui.querySelector<HTMLInputElement>('[data-testid="manual-checklist-input"]');
    assert.ok(input);
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(checklist)], 'coordination.checklist.json')],
      configurable: true,
    });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await advance(0);

    // #6690: growing library/editor controls are inside the upper scroll pane,
    // and their real callbacks still operate on the imported checklist.
    const summary = ui.querySelector('[data-validation-summary-pane]');
    const library = ui.querySelector('select[aria-label="Select checklist"]');
    const name = ui.querySelector<HTMLInputElement>('input[aria-label="Checklist name"]');
    assert.ok(summary && library && name);
    assert.equal(ui.querySelectorAll('select[aria-label="Select checklist"]').length, 1);
    assert.ok(summary.contains(library) && summary.contains(name));

    const handle = ui.querySelector<HTMLElement>('[role="separator"][aria-label="Resize validation summary"]');
    assert.ok(handle);
    assert.equal(handle.tabIndex, 0);
    assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
    const startingSize = Number(handle.getAttribute('aria-valuenow'));
    assert.ok(startingSize > 0);
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    assert.ok(Number(handle.getAttribute('aria-valuenow')) < startingSize);

    const finalRow = [...ui.querySelectorAll<HTMLElement>('[data-testid="manual-check"]')]
      .find((row) => row.textContent?.includes('Confirm delivery 12'));
    assert.ok(finalRow);
    const pass = [...finalRow.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Pass');
    assert.ok(pass);
    click(pass);
    assert.equal(finalRow.getAttribute('data-status'), 'pass');
    assert.match(ui.querySelector('[data-testid="manual-overall"] svg')?.getAttribute('aria-label') ?? '', /1 passed/);

    const tab = (name: string) => {
      const found = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) => element.textContent === name);
      assert.ok(found);
      return found;
    };
    mouseDown(tab('IDS validation'));
    mouseDown(tab('Manual validation'));
    const restoredRow = [...ui.querySelectorAll<HTMLElement>('[data-testid="manual-check"]')]
      .find((row) => row.textContent?.includes('Confirm delivery 12'));
    assert.equal(restoredRow?.getAttribute('data-status'), 'pass');

    // Radix remounts the active tab: exercise its current mounted controls.
    const restoredSummary = ui.querySelector('[data-validation-summary-pane]');
    const restoredName = restoredSummary?.querySelector<HTMLInputElement>('input[aria-label="Checklist name"]');
    assert.ok(restoredSummary && restoredName);
    const upperButton = (label: string) => {
      const found = [...restoredSummary.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
      assert.ok(found);
      return found;
    };
    click(upperButton('Edit checklist'));
    assert.equal(ui.querySelectorAll('[data-testid="manual-check-edit"]').length, 12);
    typeInput(restoredName, 'Reviewed coordination checks');
    click(upperButton('Done editing'));
    assert.equal(ui.querySelectorAll('[data-testid="manual-check"]')[11].getAttribute('data-status'), 'pass');
    click(upperButton('Save report'));
    await waitFor(() => useViewerStore.getState().savedValidationReports.some(report =>
      report.snapshot.kind === 'manual-report' && report.snapshot.checklistName === 'Reviewed coordination checks'
      && useViewerStore.getState().validationReportsStorage.items[report.id] === 'saved'), 'the moved controls generate and durably save the actual checklist report');
    const saved = useViewerStore.getState().savedValidationReports.find(report => report.snapshot.kind === 'manual-report'
      && report.snapshot.checklistName === 'Reviewed coordination checks');
    assert.ok(saved && saved.snapshot.kind === 'manual-report');
    assert.equal(saved.snapshot.groups.length, 12);
    assert.equal(saved.snapshot.groups[11].items[0].status, 'pass');

    if (modelCount > 1) {
      const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
      assert.ok(picker);
      act(() => { picker.value = 'm1'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
      const finalStatus = () => [...ui.querySelectorAll<HTMLElement>('[data-testid="manual-check"]')]
        .find((row) => row.textContent?.includes('Confirm delivery 12'))?.getAttribute('data-status');
      assert.equal(finalStatus(), 'unanswered');
      act(() => { picker.value = 'm0'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(finalStatus(), 'pass');
    }
  });
}
