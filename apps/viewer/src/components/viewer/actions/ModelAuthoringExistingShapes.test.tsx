/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readAuthoringSize } from '@/lib/actions/model-authoring-size';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });

test('#7229 mounted native edit review discloses geometry limits and applies only selected existing elements', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await seedAuthoringSample();
  const state = useViewerStore.getState(), storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const wall = state.addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2, Name: 'Reviewed native wall' });
  const beam = state.addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .3, Name: 'Excluded native beam' });
  assert.ok('expressId' in wall); assert.ok('expressId' in beam);
  const before = await parseIfc(editedModelBytes(dataStore, view));
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native existing edits', units: 'mm', frame: 'storey-local', operations: [
    { op: 'element.resize', target: { globalId: before.entities.getGlobalId(wall.expressId), ifcClass: 'IfcWall', name: 'Reviewed native wall' },
      expected: { kind: 'wall', height: 3000, thickness: 200 }, size: { kind: 'wall', height: 3500, thickness: 350 } },
    { op: 'element.profile', target: { globalId: before.entities.getGlobalId(beam.expressId), ifcClass: 'IfcBeam', name: 'Excluded native beam' },
      expected: { Type: 'Rectangle', XDim: 200, YDim: 300 }, Profile: { Type: 'I', OverallWidth: 200, OverallDepth: 400, WebThickness: 10, FlangeThickness: 30, FilletRadius: 25 } },
  ] }));
  const count = view.getMutationCount();
  const ui = render(<ModelAuthoringReview batch={batch} origin="native existing edit" />);
  assert.match(ui.textContent ?? '', /height=3000, thickness=200 mm/);
  assert.match(ui.textContent ?? '', /height=3500, thickness=350 mm/);
  assert.match(ui.textContent ?? '', /The preview shows the outer body; openings are not cut into the preview/);
  assert.match(ui.textContent ?? '', /The preview shows sharp corners and omits FilletRadius. Applying writes the specified fillet radii/);
  assert.equal(view.getMutationCount(), count, 'mounted review/geometry never publishes the draft');
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; assert.equal(boxes.length, 2);
  act(() => boxes[1].click());
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation'); assert.ok(apply);
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const after = await parseIfc(editedModelBytes(dataStore, view));
  const current = useViewerStore.getState(), model = current.models.get(SAMPLE_MODEL)!;
  const readState = { ...current, models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: after }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(after.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
  assert.deepEqual(readAuthoringSize(readState, SAMPLE_MODEL, wall.expressId, 'wall'), { kind: 'wall', height: 3.5, thickness: .35 });
  assert.deepEqual(readElementProfile(readState, SAMPLE_MODEL, beam.expressId), { Type: 'Rectangle', XDim: .2, YDim: .3 }, 'excluded native beam retains its exported pre-edit section');
});
