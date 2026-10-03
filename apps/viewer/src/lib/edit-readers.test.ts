/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
// Exercise the pre-existing viewer entrypoints. A production revert must
// still load these tests and fail assertions rather than remove their imports.
import { readAttributes, resolvePlacementChain } from './placement-core.js';
import { getModelLengthUnitScale } from './length-unit-scale.js';
import { effectiveStoreyId } from './effective-storey.js';
import { effectiveMutationRelationships } from '../sdk/adapters/query-overlay-relations.js';
import { effectiveContextType } from '../components/viewer/EntityContextMenu.effective-selection.js';

async function source(millimetres = false) {
  let text = await readFile(new URL('../../public/samples/hello-wall.ifc', import.meta.url), 'utf8');
  if (millimetres) text = text.replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor };
}

it('#6232 reads retained source placements and returns unavailable after bounded geometry releases the source index', async () => {
  const { store, view, editor } = await source();
  assert.deepEqual(resolvePlacementChain(store, view, editor, 1222)?.coordinates, [0, 0, 0]);
  const bounded = { ...store, entityIndex: undefined } as unknown as IfcDataStore;
  assert.equal(readAttributes(bounded, view, editor, 1231), null);
  assert.equal(resolvePlacementChain(bounded, view, editor, 1222), null);
});

it('#6232 derives uncached millimetre units through the common validated reader and refuses an unreliable retained index', async () => {
  const { store } = await source(true);
  assert.equal(getModelLengthUnitScale({ ...store, lengthUnitScale: undefined }), .001);
  const broken = { ...store, lengthUnitScale: undefined, entityIndex: { ...store.entityIndex,
    byId: new Proxy(store.entityIndex.byId, { get(target, key, receiver) {
      if (key === 'get') return () => { throw new Error('Index unavailable'); };
      return Reflect.get(target, key, receiver);
    } }),
  } };
  assert.throws(() => getModelLengthUnitScale(broken), /reliable model length unit scale/);
});

it('#6232 folds source containment retargets into the same effective storey view and drops tombstoned containers', async () => {
  const { store, view, editor } = await source();
  assert.equal(effectiveStoreyId(store, view, 1222), 42);
  const storey = editor.addEntity('IfcBuildingStorey', ['24hpMBCM10Oug9g6WpN$Er', null, 'Moved storey', null, null, '#65', null, null, null, 0]).expressId;
  editor.setPositionalAttribute(1223, 5, `#${storey}`);
  assert.equal(effectiveStoreyId(store, view, 1222), storey);
  assert.equal(effectiveContextType(store, view, storey), 'IfcBuildingStorey');
  assert.ok(effectiveMutationRelationships(store, view).relationships.some(relation => relation.related.includes(1222) && relation.relating.includes(storey)));
  editor.removeEntity(storey);
  assert.equal(effectiveStoreyId(store, view, 1222), undefined);
});
