/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { click, cleanup, press, render, type } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { openInlineEditor, parseStep, seedModel } from '@/test/properties-panel-harness.js';
import { PropertiesPanel } from './PropertiesPanel.js';

function wall(id: number, value: string): string {
  return `
#${id}=IFCWALL('0Wall${id}000000000000000',$,'Wall ${id}',$,$,$,$,$,$);
#${id + 1}=IFCPROPERTYSINGLEVALUE('Category',$,${value},$);
#${id + 2}=IFCPROPERTYSET('0Pset${id}000000000000000',$,'Pset_Sample',$,(#${id + 1}));
#${id + 3}=IFCRELDEFINESBYPROPERTIES('0Rels${id}000000000000000',$,$,$,(#${id}),#${id + 2});
`;
}

const step = (...walls: string[]) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('sample','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000000',$,'Project',$,$,$,$,$,$);
${walls.join('\n')}
ENDSEC;
END-ISO-10303-21;`;

const store = useViewerStore;
const initial = store.getState();
afterEach(() => { cleanup(); store.setState(initial, true); });

for (const federated of [false, true]) {
  it(`#11824 closes the property draft on a ${federated ? 'federated' : 'same-model'} selection change`, async () => {
    const first = wall(10, "IFCLABEL('Alpha')");
    const targetId = federated ? 10 : 20;
    const second = wall(targetId, 'IFCINTEGER(7)');
    const modelA = await parseStep(federated ? step(first) : step(first, second));
    seedModel('a', 0, modelA, 10);
    if (federated) {
      const modelB = await parseStep(step(second));
      store.setState({ models: new Map(store.getState().models).set('b', {
        ...fixtureModel('b', { idOffset: 1_000_000 }), ifcDataStore: modelB, maxExpressId: 100_000,
      }) });
    }
    const panel = render(<PropertiesPanel />);
    const oldRow = await openInlineEditor(panel, '10:Pset_Sample:Category');
    const draft = oldRow.querySelector<HTMLInputElement>('input[aria-label="Category"]');
    assert.ok(draft);
    assert.equal(draft.value, 'Alpha');
    assert.equal(oldRow.querySelector('[aria-pressed="true"]')?.textContent, 'String');
    type(draft, 'Unsaved draft');
    assert.equal(draft.value, 'Unsaved draft');
    const oldSave = oldRow.querySelector('button[aria-label="Save (Enter)"]');
    assert.ok(oldSave);

    const modelId = federated ? 'b' : 'a';
    act(() => {
      const current = store.getState();
      current.setSelectedEntityId(toGlobalIdFromModels(current.models, modelId, targetId));
      current.setSelectedEntity({ modelId, expressId: targetId });
    });
    assert.ok(!panel.querySelector('input[aria-label="Category"]'), 'selection closes the editor');
    assert.equal(oldSave.isConnected, false, 'the previous save control is detached');
    click(oldSave);
    assert.equal(store.getState().undoStacks.size, 0, 'no stale write was recorded');

    const nextRow = await openInlineEditor(panel, `${targetId}:Pset_Sample:Category`);
    const input = nextRow.querySelector<HTMLInputElement>('input[aria-label="Category"]');
    assert.ok(input);
    assert.equal(input.value, '7');
    assert.equal(nextRow.querySelector('[aria-pressed="true"]')?.textContent, 'Int');
    type(input, '8');
    press(input, 'Enter');
    const edits = store.getState().undoStacks.get(modelId);
    assert.equal(edits?.length, 1);
    assert.equal(edits?.[0]?.entityId, targetId);
    const category = store.getState().mutationViews.get(modelId)?.getForEntity(targetId)
      .find(pset => pset.name === 'Pset_Sample')?.properties.find(prop => prop.name === 'Category');
    assert.equal(category?.value, 8);
    assert.equal(category?.type, PropertyValueType.Integer);
    assert.ok(!panel.querySelector('input[aria-label="Category"]'), 'saving closes the fresh editor');
  });
}
