/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Add block › Manual validation report" (#6401) in the real Document panel:
 * the block snapshots the Manual validation tab's checklist and the active
 * model's answers, the preview shows the rings and every verdict, and the
 * snapshot stays frozen until Refresh.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { cleanup, click, render } from '@/test/render.js';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { DocumentPanel } from './DocumentPanel.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

function openMenu(trigger: Element): void {
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

function menuItem(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(text));
}

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Tower',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parsedModel(id: string, name: string, sourceFingerprint: string): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id), name, sourceFingerprint, ifcDataStore: store, maxExpressId: 2 } as FederatedModel;
}
const towerModel = (): Promise<FederatedModel> => parsedModel('m1', 'tower.ifc', 'fp-tower');
const initial = useViewerStore.getState();

beforeEach(async () => {
  localStorage.clear();
  const model = await towerModel();
  useViewerStore.setState({
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    documents: [],
    activeDocumentId: null,
    dashboards: [],
    bcfProject: null,
    manualChecklist: {
      version: CHECKLIST_VERSION,
      name: 'Coordination round 3',
      groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'Uploaded on time' }, { id: 'b', text: 'Naming convention' }] }],
    },
    manualAnswers: { 'fp-tower': { a: { status: 'pass', updatedAt: 1 }, b: { status: 'warning', comment: 'Old prefix', updatedAt: 1 } } },
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ ...initial, models: new Map(), manualChecklist: null, manualAnswers: {} });
});

describe('Document panel manual validation report (#6401)', () => {
  it('adds a frozen snapshot of the checklist and the active model\'s answers, and Refresh re-takes it', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = menuItem('Manual validation report');
    assert.ok(item, 'the menu offers a manual validation report');
    click(item);
    await settle();

    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((b): b is ManualReportBlock => b.kind === 'manual-report')!;
    assert.equal(stored().modelName, 'tower.ifc');
    assert.deepEqual(stored().summary, { total: 2, pass: 1, fail: 0, warning: 1, unanswered: 0 });

    const preview = ui.querySelector('[data-block-manual-report]')!;
    assert.match(preview.textContent ?? '', /Manual validation: Coordination round 3/);
    assert.deepEqual([...preview.querySelectorAll('li[data-status]')].map((li) => li.getAttribute('data-status')), ['pass', 'warning']);
    assert.ok(preview.querySelector('svg[aria-label="Overall: 1 passed, 1 with warnings, 0 failed, 0 not checked"]'));
    assert.match(preview.textContent ?? '', /Old prefix/);

    // A later answer does not reach the saved block until Refresh.
    act(() => { useViewerStore.getState().setManualAnswer('fp-tower', 'b', { status: 'fail' }); });
    await settle();
    assert.equal(stored().groups[0].items[1].status, 'warning');
    click([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Refresh from current checklist')!);
    await settle();
    assert.equal(stored().groups[0].items[1].status, 'fail');
    assert.deepEqual(stored().summary, { total: 2, pass: 1, fail: 1, warning: 0, unanswered: 0 });
  });

  // CodeRabbit on #6486: Refresh found the model by display name and fell back to the active
  // one, so it could snapshot another model's answers and still toast success.
  it('Refresh reads the model the block was taken from, and says so instead of reading another when it is not loaded', async () => {
    const tower = useViewerStore.getState().models.get('m1')!;
    const annex = await parsedModel('m2', 'tower.ifc', 'fp-annex'); // same display name, different file
    useViewerStore.setState({
      models: new Map([['m1', tower], ['m2', annex]]),
      activeModelId: 'm2',
      manualAnswers: { ...useViewerStore.getState().manualAnswers, 'fp-annex': { a: { status: 'fail', updatedAt: 1 } } },
    });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    click(menuItem('Manual validation report')!);
    await settle();
    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((b): b is ManualReportBlock => b.kind === 'manual-report')!;
    assert.equal(stored().modelFingerprint, 'fp-annex');
    const refresh = (): HTMLButtonElement => [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Refresh from current checklist')!;

    // Another model becomes active and the annex gains an answer: Refresh still reads the annex.
    act(() => {
      useViewerStore.setState({ activeModelId: 'm1' });
      useViewerStore.getState().setManualAnswer('fp-annex', 'b', { status: 'pass' });
    });
    await settle();
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-annex');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['fail', 'pass']);

    // The annex is unloaded: no silent switch to the tower's answers.
    act(() => { useViewerStore.setState({ models: new Map([['m1', tower]]), activeModelId: 'm1' }); });
    await settle();
    assert.match(ui.querySelector('[data-manual-report-model-missing]')?.textContent ?? '', /\(tower\.ifc\) is not loaded/);
    assert.equal(refresh().disabled, true);
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-annex');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['fail', 'pass']);

    // An explicit pick re-binds the block to that model.
    // #6485 also offers m1 in text-field sources. Pick the labelled answers
    // control, as a user does, rather than the first select sharing that option.
    const select = [...ui.querySelectorAll('select')].find((el) => el.closest('label')?.textContent?.trim().startsWith('Answers from'));
    assert.ok(select, 'the manual report offers its own answers-model picker');
    act(() => {
      // Through the prototype setter, so React's value tracker sees the change.
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'm1');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    assert.ok(!ui.querySelector('[data-manual-report-model-missing]'), 'the picked model clears the not-loaded state');
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-tower');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['pass', 'warning']);
  });

  it('is unavailable until a checklist exists', async () => {
    useViewerStore.setState({ manualChecklist: null });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = menuItem('Manual validation report');
    assert.equal(item?.getAttribute('aria-disabled'), 'true');
  });
});
