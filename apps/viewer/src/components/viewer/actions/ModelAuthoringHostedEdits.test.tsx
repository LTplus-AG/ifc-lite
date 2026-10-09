/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { readHostedFill, readHostedElementSize } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : ''); return value.expressId;
};
test('#7265 mounted review discloses native hosted bounds and selectively edits one occurrence', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await seedAuthoringSample(), state = useViewerStore.getState();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const host = created(state.addWall(SAMPLE_MODEL, storey, { Start: [20, 20, 0], End: [32, 20, 0], Thickness: .25, Height: 4 }));
  const ids = [2, 8].map((Offset, index) => created(useViewerStore.getState().addHostedFill(SAMPLE_MODEL, host, {
    kind: 'window', params: { Offset, Sill: .7, Width: 1, Height: 1.2, Name: `Reviewed native window ${index}` } })));
  const before = await parseIfc(editedModelBytes(dataStore, view));
  const operations = ids.map(id => {
    const binding = readHostedFill(before, id); assert.ok(binding);
    return { op: 'hosted.edit', target: { modelId: SAMPLE_MODEL, globalId: before.entities.getGlobalId(id), ifcClass: 'IfcWindow', name: before.entities.getName(id) },
      expected: { ...binding, location: binding.location.map(value => value * getModelLengthUnitScale(before)), size: readHostedElementSize(before, id) },
      edit: { Sill: .5, OverallWidth: 1.3 } };
  });
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Selective hosted edit', units: 'm', frame: 'storey-local', operations }));
  const count = view.getMutationCount(), ui = render(<ModelAuthoringReview batch={batch} origin="native hosted review" />);
  assert.match(ui.textContent ?? '', /Offset=2, Sill=0.7, OverallWidth=1, OverallHeight=1.2 m/);
  assert.match(ui.textContent ?? '', /Sill=0.5, OverallWidth=1.3 m/);
  assert.match(ui.textContent ?? '', /Preview shows the opening bounds only; filling geometry, styles and detailed cut shapes are authoritative at native commit/);
  assert.equal(view.getMutationCount(), count, 'review and its native draft preview never publish edits');
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; assert.equal(boxes.length, 2);
  act(() => boxes[1].click());
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation'); assert.ok(apply);
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const after = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(readHostedFill(after, ids[0])?.sill, .5);
  assert.deepEqual(readHostedElementSize(after, ids[0]), { OverallWidth: 1.3, OverallHeight: 1.2 });
  assert.deepEqual(readHostedFill(after, ids[1]), readHostedFill(before, ids[1]), 'unchecked sibling retains actual native binding and pose');
  assert.deepEqual(readHostedElementSize(after, ids[1]), readHostedElementSize(before, ids[1]));
});
