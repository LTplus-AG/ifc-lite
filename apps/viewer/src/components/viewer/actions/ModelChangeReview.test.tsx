/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { ModelChangeReview } from './ModelChangeReview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

const W1 = '0Wall00000000000000101';
const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('r.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);\n#101=IFCWALL('${W1}',$,'W1',$,$,$,$,'T1',$);\nENDSEC;\nEND-ISO-10303-21;`;

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check());
}

test('the review card gates on Edit mode, applies approved rows once and undoes them from the receipt', async () => {
  await modelChangeLibrary.initialize();
  const bytes = new TextEncoder().encode(source);
  const data = await new IfcParser().parseColumnar(bytes.buffer.slice(0));
  const view = new MutablePropertyView(data.properties, 'A');
  useViewerStore.setState({ models: new Map([['A', { ...fixtureModel('A'), ifcDataStore: data }]]), activeModelId: 'A', ifcDataStore: data,
    mutationViews: new Map([['A', view]]), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    dirtyModels: new Set(), editEnabled: false, collabRole: null, collabRoomId: null, mutationVersion: 0 });
  const batch = parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: 'Name the wall', changes: [
    { op: 'attribute.set', target: { globalId: W1 }, name: 'Name', expected: 'W1', value: 'Wall 1' },
    { op: 'property.set', target: { globalId: W1 }, pset: 'Pset_WallCommon', name: 'FireRating', expected: null, value: 'EI60' }] }));
  const ui = render(<ModelChangeReview batch={batch} origin="test" />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent?.startsWith(text));

  assert.equal(button('Apply')?.disabled, true, 'nothing is applicable while edits are denied');
  click(button('Turn on Edit mode')!);
  assert.equal(useViewerStore.getState().editEnabled, true);
  assert.equal(button('Apply')?.textContent, 'Apply 2 changes');

  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  act(() => boxes[1].click());
  assert.equal(button('Apply')?.textContent, 'Apply 1 change', 'per-row approval');
  click(button('Apply')!);
  assert.match(ui.textContent ?? '', /Applied 1 change as one undo step/);
  const name = () => view.getAttributeMutationsForEntity(101).find(m => m.name === 'Name')?.value ?? data.entities.getName(101);
  assert.equal(name(), 'Wall 1');
  assert.equal(view.getPropertyValue(101, 'Pset_WallCommon', 'FireRating'), null, 'the excluded row was not written');
  await waitFor(() => useModelChangeReceipts.getState().entries.length === 1);

  click(button('Undo these changes')!);
  await waitFor(() => useModelChangeReceipts.getState().entries[0]?.status === 'undone');
  assert.equal(name(), 'W1', 'undo restores the reviewed value');
  assert.match(ui.textContent ?? '', /Undid 1 change/);
});
