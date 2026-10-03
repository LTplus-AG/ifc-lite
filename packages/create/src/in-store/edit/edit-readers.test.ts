/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readAttributes, resolvePlacementChain } from './placement-core.js';
import { getModelLengthUnitScale } from './length-unit-scale.js';
import { effectiveStoreyId } from './effective-storey.js';
import { effectiveMutationRelationships, effectiveContextType } from './effective-mutation-view.js';

async function source(millimetres = false) {
  let text = await readFile(new URL('../../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8');
  if (millimetres) text = text.replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor };
}

it('#6232 reads retained source placements and returns unavailable after bounded geometry releases the source index', async () => {
  const { store, view, editor } = await source();
  expect(resolvePlacementChain(store, view, editor, 1222)?.coordinates).toEqual([0, 0, 0]);
  const bounded = { ...store, entityIndex: undefined } as unknown as IfcDataStore;
  expect(readAttributes(bounded, view, editor, 1231)).toBeNull();
  expect(resolvePlacementChain(bounded, view, editor, 1222)).toBeNull();
});

it('#6232 derives uncached millimetre units through the common validated reader and refuses an unreliable retained index', async () => {
  const { store } = await source(true);
  expect(getModelLengthUnitScale({ ...store, lengthUnitScale: undefined })).toBe(.001);
  const broken = { ...store, lengthUnitScale: undefined, entityIndex: { ...store.entityIndex,
    byId: new Proxy(store.entityIndex.byId, { get(target, key, receiver) {
      if (key === 'get') return () => { throw new Error('Index unavailable'); };
      return Reflect.get(target, key, receiver);
    } }),
  } };
  expect(() => getModelLengthUnitScale(broken)).toThrow('reliable model length unit scale');
});

it('#6232 folds source containment retargets into the same effective storey view and drops tombstoned containers', async () => {
  const { store, view, editor } = await source();
  expect(effectiveStoreyId(store, view, 1222)).toBe(42);
  const storey = editor.addEntity('IfcBuildingStorey', ['24hpMBCM10Oug9g6WpN$Er', null, 'Moved storey', null, null, '#65', null, null, null, 0]).expressId;
  editor.setPositionalAttribute(1223, 5, `#${storey}`);
  expect(effectiveStoreyId(store, view, 1222)).toBe(storey);
  expect(effectiveContextType(store, view, storey)).toBe('IfcBuildingStorey');
  expect(effectiveMutationRelationships(store, view).relationships.some(relation => relation.related.includes(1222) && relation.relating.includes(storey))).toBe(true);
  editor.removeEntity(storey);
  expect(effectiveStoreyId(store, view, 1222)).toBeUndefined();
});
