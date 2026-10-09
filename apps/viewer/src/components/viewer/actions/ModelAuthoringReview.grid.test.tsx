/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { rectangularGridAxes } from '@ifc-lite/create';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });
test('#7304 actual mounted review excludes a dependent column, exports the approved native binding and undoes both rows', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Explicit native grid', units: 'mm', frame: 'storey-local', operations: [
    { op: 'grid.create', ref: 'g', storey: { modelId: SAMPLE_MODEL, globalId: GROUND_STOREY }, params: { Position: [0, 0, 0], Direction: 0, Name: 'Mounted design grid', ...rectangularGridAxes({ UOffsets: [0, 6000], VOffsets: [0, 4000], Overhang: 1000 }) } },
    { op: 'column.createOnGrid', ref: 'c', storey: { modelId: SAMPLE_MODEL, globalId: GROUND_STOREY }, grid: { ref: 'g', IntersectingAxes: ['2', 'B'] }, params: { Position: [6000, 4000, 0], Width: 400, Depth: 200, Height: 3000, Name: 'Mounted bound column' } },
  ] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent?.startsWith(text));
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(button('Apply')?.textContent, 'Apply 2 operations');
  act(() => boxes[0].click());
  assert.equal(boxes[1].checked, false); assert.equal(button('Apply')?.disabled, true);
  assert.equal(view.getNewEntities().length, 0);
  act(() => boxes[0].click());
  if (!boxes[1].checked) act(() => boxes[1].click());
  assert.equal(button('Apply')?.textContent, 'Apply 2 operations', ui.textContent ?? '');
  click(button('Apply')!);
  assert.ok(ui.textContent?.includes('Applied 2 changes as one undo step'), ui.textContent ?? '');
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const parsed = await parseIfc(bytes);
  assert.equal(view.getNewEntities().filter(row => row.type === 'IfcGrid').length, 1);
  assert.equal(view.getNewEntities().filter(row => row.type === 'IfcColumn').length, 1);
  assert.ok([...parsed.entityIndex.byId.values()].some(row => row.type === 'IFCGRIDPLACEMENT'));
  assert.equal(button('Apply'), undefined, 'a completed card cannot apply again');
  click(button('Undo these changes')!);
  assert.equal(view.getNewEntities().length, 0, 'receipt Undo removes the native grid and its dependent column together');
});
