/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { expandAffectedSet } from './affected-set.js';
import { StepExporter } from '@ifc-lite/export';

async function fixture() {
  const bytes = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor };
}

for (const persisted of [false, true]) {
  it(`#6232 remeshes the Bonsai host and filling for a StandardCase opening shape edit (${persisted ? 'persisted' : 'retyped'})`, async () => {
    let { store, view, editor } = await fixture();
    // Actual source relationships: #1328 voids wall #1222 with opening #1299;
    // #1334 fills that opening with door #1262.
    assert.deepEqual(expandAffectedSet(store, view, [1299], 'shape'), new Set([1299, 1222, 1262]));
    editor.setEntityType(1299, 'IfcOpeningStandardCase');
    if (persisted) {
      const content = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
      store = await new IfcParser().parseColumnar(new Uint8Array(content).buffer, { disableWorkerScan: true });
      view = new MutablePropertyView(null, 'm');
      editor = new StoreEditor(store, view);
    }
    const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    const saved = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content;
    const beforeBytes = saved();
    assert.deepEqual(expandAffectedSet(store, view, [1299], 'shape'), new Set([1299, 1222, 1262]));
    assert.deepEqual({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }, before);
    assert.deepEqual(saved(), beforeBytes);
  });
}

it('#6232 includes the actual host of an overlay-created StandardCase opening without moving unrelated openings', async () => {
  const { store, view, editor } = await fixture();
  // Reuse the actual source opening's placement/body as another read-only occurrence.
  const opening = editor.addEntity('IfcOpeningStandardCase', [
    '0A11v8jlH2FQLqo31oaSd8', null, 'Added opening', null, null, '#1344', '#1327', null, '.OPENING.',
  ]).expressId;
  editor.addEntity('IfcRelVoidsElement', ['0A11v8jlH2FQLqo31oaSd9', null, null, null, '#1222', `#${opening}`]);
  const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
  assert.deepEqual(expandAffectedSet(store, view, [opening], 'shape'), new Set([opening, 1222]));
  assert.deepEqual({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }, before);
});

it('#6232 excludes a StandardCase opening reached only through a selected host shape context', async () => {
  const { store, view, editor } = await fixture();
  editor.setEntityType(1443, 'IfcOpeningStandardCase');
  // The other source opening's filling #1407 still belongs to the context,
  // while its unchanged opening #1443 is excluded like IfcOpeningElement.
  assert.deepEqual(expandAffectedSet(store, view, [1299, 1222], 'shape'), new Set([1299, 1222, 1262, 1407]));
  assert.deepEqual(expandAffectedSet(store, view, [1222], 'shape'), new Set([1222]));
  editor.removeEntity(1262);
  assert.deepEqual(expandAffectedSet(store, view, [1299], 'shape'), new Set([1299, 1222]));
  editor.removeEntity(1299);
  assert.deepEqual(expandAffectedSet(store, view, [1299], 'shape'), new Set());
});
