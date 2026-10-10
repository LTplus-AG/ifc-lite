/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

test('#7215 mounted review discloses native polygon/profile dimensions and applies only selected independent shapes', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await seedAuthoringSample();
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native shape review', units: 'mm', frame: 'storey-local', operations: [
    { op: 'element.create', ref: 'floor', ifcClass: 'IfcSlab', storey: { globalId: GROUND_STOREY }, name: 'Review polygon',
      params: { Profile: 'polygon', OuterCurve: [[0, 0], [4000, 0], [4000, 2000], [2000, 2000], [2000, 4000], [0, 4000]], thickness: 200 } },
    { op: 'element.create', ref: 'fillet', ifcClass: 'IfcColumn', storey: { globalId: GROUND_STOREY }, name: 'Review fillet', params: { position: [0, 0, 0], height: 3000, Profile: { Type: 'I', OverallWidth: 200, OverallDepth: 400, WebThickness: 10, FlangeThickness: 30, FilletRadius: 25 } } },
    { op: 'element.create', ref: 'pipe', ifcClass: 'IfcBeam', storey: { globalId: GROUND_STOREY }, name: 'Review pipe',
      params: { start: [0, 0, 3000], end: [4000, 0, 3000], Profile: { Type: 'CircleHollow', Radius: 200, WallThickness: 20 } } },
  ] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="native shape test" />);
  assert.match(ui.textContent ?? '', /polygon · 6 vertices · \(0, 0, 0\) · 200 mm/);
  assert.match(ui.textContent ?? '', /CircleHollow · Radius=200, WallThickness=20 · \(0, 0, 3000\) → \(4000, 0, 3000\) mm/);
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.match(ui.textContent ?? '', /The preview shows sharp corners and omits FilletRadius. Applying writes the specified fillet radii/);
  act(() => { boxes[0].click(); boxes[1].click(); });
  const button = [...ui.querySelectorAll('button')].find((item) => item.textContent?.startsWith('Apply'))!;
  assert.equal(button.textContent, 'Apply 1 operation');
  assert.equal(view.getNewEntities().length, 0, 'review/exclusion writes nothing');
  click(button);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const reparsed = await parseIfc(editedModelBytes(dataStore, view));
  const names = [...reparsed.entityIndex.byId.keys()].map((id) => reparsed.entities.getName(id));
  assert.ok(names.includes('Review pipe'), 'selected native hollow-section beam exports');
  assert.ok(!names.includes('Review polygon'), 'excluded independent polygon is not authored');
});
