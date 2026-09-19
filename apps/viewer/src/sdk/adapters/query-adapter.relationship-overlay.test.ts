/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createQueryAdapter } from './query-adapter.js';
import { createStoreAdapter } from './store-adapter.js';
import type { StoreApi } from './types.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDING('0000000000000000000002',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'First wall',$,$,$,$,$,$);
#4=IFCWALL('0000000000000000000004',$,'Replacement wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

function makeStore(dataStore: IfcDataStore): StoreApi {
  const mutationViews = new Map<string, MutablePropertyView>();
  const state = {
    ifcDataStore: dataStore,
    models: new Map(),
    mutationViews,
    getMutationView: (modelId: string) => mutationViews.get(modelId) ?? null,
    registerMutationView: (modelId: string, view: MutablePropertyView) => { mutationViews.set(modelId, view); },
  };
  return {
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('viewer exact relationship queries fold authored records and endpoint overrides', async () => {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const store = makeStore(dataStore);
  const query = createQueryAdapter(store);
  const writes = createStoreAdapter(store);
  const building = { modelId: 'default', expressId: 2 };
  const relationship = writes.addEntity('default', {
    type: 'IfcRelAggregates',
    attributes: ["'0000000000000000000005'", null, null, null, '#2', ['#3']],
  });

  assert.deepEqual(query.related(building, 'IfcRelAggregates', 'forward'), [{ modelId: 'default', expressId: 3 }]);
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 3 && edge.entity.name === 'First wall'), true);

  writes.setPositionalAttribute(relationship, 5, ['#4']);
  assert.deepEqual(query.related(building, 'IfcRelAggregates', 'forward'), [{ modelId: 'default', expressId: 4 }]);
  const rows = query.relationships(building).relations ?? [];
  assert.equal(rows.some((edge) => edge.relationshipId === relationship.expressId && edge.entity.id === 3), false);
  assert.equal(rows.some((edge) => edge.relationshipId === relationship.expressId
    && edge.entity.id === 4 && edge.entity.name === 'Replacement wall'), true);
});
