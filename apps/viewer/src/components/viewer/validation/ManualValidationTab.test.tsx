/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Data validation panel's Manual validation tab (#6401), mounted through
 * the real `ValidationPanel`: create a checklist from the empty state, record
 * verdicts and comments against a model's source fingerprint, open and save
 * a `.checklist.json`, and keep answers per model.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { activate, cleanup, click, render, type as typeInput } from '@/test/render.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { loadManualAnswers } from '@/lib/validation/manual/persistence';
import { loadRecentChecklists } from '@/lib/validation/manual/recent-checklists';
import { ValidationPanel } from './ValidationPanel.js';

function model(id: string, fingerprint: string): FederatedModel {
  return { ...fixtureModel(id), name: `${id}.ifc`, sourceFingerprint: fingerprint } as FederatedModel;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

function byLabel<T extends Element>(root: ParentNode, label: string): T {
  const found = root.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`nothing labelled "${label}"`);
  return found as T;
}

function checkRow(root: ParentNode, text: string): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>('[data-testid="manual-check"]')].find((r) => r.textContent?.includes(text));
  if (!row) throw new Error(`no check row "${text}"`);
  return row;
}

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const CHECKLIST_JSON = JSON.stringify({
  version: 1,
  name: 'Coordination round',
  groups: [
    { id: 'delivery', name: 'Delivery', items: [{ id: 'on-time', text: 'Uploaded to the CDE on time' }] },
    { id: 'structure', name: 'Structure', items: [{ id: 'storeys', text: 'Objects are on the right storey' }] },
  ],
});

const initial = useViewerStore.getState();

beforeEach(() => {
  localStorage.clear();
  clearDownloads();
  setValidationSourceChoice(null);
  useViewerStore.setState({ ...initial, manualChecklist: null, manualAnswers: {}, manualSaveError: null });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ ...initial, models: new Map(), manualChecklist: null, manualAnswers: {} });
});

describe('Manual validation tab (#6401)', () => {
  it('builds a checklist from the empty state and records verdicts per model; a warning is not a pass', () => {
    useViewerStore.setState(fixtureModels(model('m1', 'fp-1')));
    const ui = render(<ValidationPanel />);

    const card = ui.querySelector('[data-testid="validation-entry-manual"]')!;
    click(buttonByText(card, 'New checklist'));
    // A new, empty checklist opens in editing mode on the Manual validation tab.
    assert.equal(ui.querySelector('[role="tab"][data-state="active"]')?.textContent, 'Manual validation');

    typeInput(byLabel<HTMLInputElement>(ui, 'Checklist name'), 'Weekly check');
    click(buttonByText(ui, 'Add group'));
    click(buttonByText(ui, 'Add check'));
    click(buttonByText(ui, 'Add check'));
    const texts = ui.querySelectorAll<HTMLInputElement>('input[aria-label="What was checked"]');
    typeInput(texts[0], 'Uploaded on time');
    typeInput(texts[1], 'Storeys are named');
    click(buttonByText(ui, 'Done editing'));

    // Both checks start in their own "Not checked" state.
    assert.deepEqual([...ui.querySelectorAll('[data-testid="manual-check"]')].map((r) => r.getAttribute('data-status')), ['unanswered', 'unanswered']);

    click(buttonByText(checkRow(ui, 'Uploaded on time'), 'Pass'));
    // Keyboard: the verdict controls are native buttons reachable by Tab and activated by Enter/Space.
    activate(buttonByText(checkRow(ui, 'Storeys are named'), 'Warning'), ' ');

    const overall = ui.querySelector('[data-testid="manual-overall"] svg[role="img"]');
    assert.equal(overall?.getAttribute('aria-label'), 'Overall: 1 passed, 1 with warnings, 0 failed, 0 not checked');
    assert.ok(ui.querySelector('svg[aria-label="New group: 1 passed, 1 with warnings, 0 failed, 0 not checked"]'));
    assert.equal(ui.querySelector('[data-testid="manual-overall"] text')?.textContent, '50%');

    typeInput(byLabel<HTMLTextAreaElement>(ui, 'Comment on Storeys are named'), 'Level 3 is called "L3 new"');

    // Persisted under the model's fingerprint, so it survives a reload.
    const itemIds = useViewerStore.getState().manualChecklist!.groups[0].items.map((i) => i.id);
    const stored = loadManualAnswers()['fp-1'];
    assert.equal(stored[itemIds[0]].status, 'pass');
    assert.equal(stored[itemIds[1]].status, 'warning');
    assert.equal(stored[itemIds[1]].comment, 'Level 3 is called "L3 new"');

    // Pressing the active verdict again clears it back to "Not checked".
    const pass = buttonByText(checkRow(ui, 'Uploaded on time'), 'Pass');
    assert.equal(pass.getAttribute('aria-pressed'), 'true');
    click(pass);
    assert.equal(checkRow(ui, 'Uploaded on time').getAttribute('data-status'), 'unanswered');
    assert.equal(loadManualAnswers()['fp-1'][itemIds[0]], undefined);
  });

  it('opens a .checklist.json, lists it under Recent, and saves the template back as a file', async () => {
    useViewerStore.setState(fixtureModels(model('m1', 'fp-1')));
    setValidationSourceChoice('manual');
    const ui = render(<ValidationPanel />);

    const input = ui.querySelector<HTMLInputElement>('[data-testid="manual-checklist-input"]')!;
    await selectFile(input, new File([CHECKLIST_JSON], 'round.checklist.json', { type: 'application/json' }));

    assert.deepEqual([...ui.querySelectorAll('[data-testid="manual-group"] h3')].map((h) => h.textContent), ['Delivery', 'Structure']);
    assert.deepEqual(loadRecentChecklists().map((e) => e.name), ['Coordination round']);

    click(checkRow(ui, 'Uploaded to the CDE on time').querySelector('button[aria-pressed]')!);
    click(byLabel(ui, 'Save .checklist.json'));
    assert.deepEqual(downloadedNames(), ['Coordination round.checklist.json']);
    // The saved file (as cached for Recent) is the template only — no verdict leaks into it.
    const saved = JSON.parse(loadRecentChecklists()[0].content) as Record<string, unknown>;
    assert.deepEqual(saved, JSON.parse(CHECKLIST_JSON));
  });

  it('reports a broken file with its reason and keeps the tab on the entry', async () => {
    setValidationSourceChoice('manual');
    const ui = render(<ValidationPanel />);
    const input = ui.querySelector<HTMLInputElement>('[data-testid="manual-checklist-input"]')!;
    await selectFile(input, new File(['{"version":1,"name":"x","groups":[{"id":"g","name":"G","items":[{"id":"g","text":"dup"}]}]}'], 'bad.checklist.json'));
    assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /"bad.checklist.json" is not a valid checklist: .*"g" is used twice/);
    assert.equal(useViewerStore.getState().manualChecklist, null);
  });

  it('keeps answers separate per model, and does not touch the IDS / information report slot', async () => {
    useViewerStore.setState(fixtureModels(model('m1', 'fp-1'), model('m2', 'fp-2')));
    setValidationSourceChoice('manual');
    const ui = render(<ValidationPanel />);
    await selectFile(ui.querySelector<HTMLInputElement>('[data-testid="manual-checklist-input"]')!, new File([CHECKLIST_JSON], 'c.checklist.json'));

    click(buttonByText(checkRow(ui, 'Uploaded to the CDE on time'), 'Fail'));
    const picker = ui.querySelector('select')!;
    act(() => {
      picker.value = 'm2';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(checkRow(ui, 'Uploaded to the CDE on time').getAttribute('data-status'), 'unanswered');
    click(buttonByText(checkRow(ui, 'Uploaded to the CDE on time'), 'Pass'));

    assert.deepEqual(loadManualAnswers()['fp-1']['on-time'].status, 'fail');
    assert.deepEqual(loadManualAnswers()['fp-2']['on-time'].status, 'pass');
    assert.equal(useViewerStore.getState().idsValidationReport, null);
  });

  it('reorders and deletes groups and checks in editing mode', async () => {
    setValidationSourceChoice('manual');
    const ui = render(<ValidationPanel />);
    await selectFile(ui.querySelector<HTMLInputElement>('[data-testid="manual-checklist-input"]')!, new File([CHECKLIST_JSON], 'c.checklist.json'));
    click(buttonByText(ui, 'Edit checklist'));

    const moveDown = ui.querySelectorAll<HTMLButtonElement>('button[aria-label="Move group down"]');
    assert.equal(moveDown[1].disabled, true);
    click(moveDown[0]);
    assert.deepEqual(useViewerStore.getState().manualChecklist!.groups.map((g) => g.id), ['structure', 'delivery']);

    click(ui.querySelectorAll('button[aria-label="Delete check"]')[0]);
    assert.deepEqual(useViewerStore.getState().manualChecklist!.groups[0].items, []);
    click(ui.querySelectorAll('button[aria-label="Delete group"]')[1]);
    assert.deepEqual(useViewerStore.getState().manualChecklist!.groups.map((g) => g.id), ['structure']);
  });
});
