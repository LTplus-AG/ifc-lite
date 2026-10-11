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
import { BACK_WALL, BACK_WALL_NAME, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { ModelAuthoringReview } from '@/components/viewer/actions/ModelAuthoringReview';
import { parseModelAuthoringBatch } from './model-authoring';
import { modelChangeLibrary } from './receipts';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

test('#7202 mounted review counts approved array roots, discloses ghost limits, and excludes edits needing an unapproved copy', async () => {
  await modelChangeLibrary.initialize();
  const { view } = await seedAuthoringSample();
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Reviewed polar copies', units: 'mm', frame: 'storey-local', operations: [
    { op: 'element.array', target: { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME }, refs: ['a', 'b'], mode: 'polar', count: 3, anchor: [0, 0], angleDeg: 90 },
    { op: 'material.assign', target: { ref: 'b' }, material: { name: 'Polar finish', create: true } },
  ] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  assert.match(ui.textContent ?? '', /2 new root copies/);
  assert.match(ui.textContent ?? '', /90° @ \(0, 0\) mm/);
  assert.match(ui.textContent ?? '', /first 64 placements/);
  assert.match(ui.textContent ?? '', /sources without loaded meshes have no copy ghost/);
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent?.startsWith('Apply'))!;
  assert.equal(apply.textContent, 'Apply 2 operations');
  act(() => boxes[0].click());
  assert.equal(apply.disabled, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(view.getNewEntities().length, 0);
  act(() => boxes[0].click());
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 3 changes as one undo step/);
  assert.equal(view.getNewEntities().filter(entity => entity.type === 'IfcWall').length, 2);
});


test('#7202 native linear review distinguishes fit total span from per-copy spacing before approval', async () => {
  await seedAuthoringSample();
  const target = { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME };
  const op = { op: 'element.array', target, mode: 'linear', count: 3, anchor: [0, 0], cursor: [1000, 0], distance: 1000 };
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Fit versus spacing', units: 'mm', frame: 'storey-local', operations: [
    { ...op, refs: ['fit-a', 'fit-b'], fit: true }, { ...op, refs: ['spaced-a', 'spaced-b'], fit: false },
  ] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  const rows = [...ui.querySelectorAll('ul[aria-label="Proposed operations"] > li')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent ?? '', /total span: 1000 mm/);
  assert.match(rows[1].textContent ?? '', /spacing: 1000 mm/);
});
