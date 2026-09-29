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

async function towerModel(): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel('m1'), name: 'tower.ifc', sourceFingerprint: 'fp-tower', ifcDataStore: store, maxExpressId: 2 } as FederatedModel;
}
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

  it('is unavailable until a checklist exists', async () => {
    useViewerStore.setState({ manualChecklist: null });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = menuItem('Manual validation report');
    assert.equal(item?.getAttribute('aria-disabled'), 'true');
  });
});
