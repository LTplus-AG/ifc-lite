/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { registerEntityMaps } from './entity-paths.js';
import { hydrateStructuredEntityAttributes } from './room-structured-attributes.js';

test('room reconstruction restores generic positional values and remaps references (#5008)', () => {
  const types = new Map([[1, 'IfcCostValue'], [91, 'IfcCostValue']]);
  const entities = [...types].map(([expressId, type]) => ({ expressId, type, attributes: [] }));
  const store = {
    schemaVersion: 'IFC5',
    entities: { getTypeName: (id: number) => types.get(id) ?? 'Unknown' },
    getEntity: (id: number) => entities.find(entity => entity.expressId === id) ?? null,
    getEntitiesByType: (type: string) => entities.filter(entity => entity.type === type),
  } as unknown as IfcDataStore;
  const paths = new Map([['/m0/value', 1], ['/m0/component', 91]]);
  registerEntityMaps(store, new Map([[1, '/m0/value'], [91, '/m0/component']]), paths);

  const diagnostics = hydrateStructuredEntityAttributes(store, paths, path => path === '/m0/value'
    ? { attributes: {
        'bsi::ifc::prop::Name': 'Total',
        'bsi::ifc::prop::Components': [{ 'ifc-lite::entityPath': '/m0/component' }],
      } }
    : undefined);

  assert.deepEqual(diagnostics, []);
  assert.equal(store.getEntity(1)?.attributes[0], 'Total');
  assert.deepEqual(store.getEntity(1)?.attributes[9], ['#91']);
  assert.deepEqual(store.getEntitiesByType('IfcCostValue')[0]?.attributes[9], ['#91']);
});

test('room reconstruction reports unresolved generic references instead of writing local ids (#5008)', () => {
  const entity = { expressId: 1, type: 'IfcCostValue', attributes: [] };
  const store = {
    schemaVersion: 'IFC5',
    entities: { getTypeName: () => 'IfcCostValue' },
    getEntity: () => entity,
    getEntitiesByType: () => [entity],
  } as unknown as IfcDataStore;
  const paths = new Map([['/m0/value', 1]]);
  registerEntityMaps(store, new Map([[1, '/m0/value']]), paths);

  const diagnostics = hydrateStructuredEntityAttributes(store, paths, () => ({ attributes: {
    'bsi::ifc::prop::Components': [{ 'ifc-lite::entityPath': '/m0/missing' }],
  } }));

  assert.deepEqual(diagnostics, ['/m0/value.Components: unresolved room reference: /m0/missing']);
  assert.equal(store.getEntity(1)?.attributes[9], null);
});
