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
#5=IFCRELAGGREGATES('0000000000000000000005',$,$,$,#2,(#3));
#7=IFCOPENINGELEMENT('0000000000000000000007',$,'Opening',$,$,$,$,$,$);
#8=IFCWALL('0000000000000000000008',$,'Host',$,$,$,$,$,$);
#9=IFCRELVOIDSELEMENT('0000000000000000000009',$,$,$,#8,#7);
#10=IFCGROUP('0000000000000000000010',$,'Factor group',$,$);
#11=IFCRELASSIGNSTOGROUPBYFACTOR('0000000000000000000011',$,$,$,(#3),$,#10,0.5);
#12=IFCDOORSTANDARDCASE('0000000000000000000012',$,'Exact door',$,$,$,$,$,$,$,$,$,$);
#13=IFCRELAGGREGATES('0000000000000000000013',$,$,$,#1,(#12));
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
  const view = store.getState().mutationViews.get('__legacy__') ?? store.getState().mutationViews.get('default');
  assert.ok(view);

  assert.deepEqual(query.relationships({ modelId: 'default', expressId: 3 }).groups, [
    { id: 10, name: 'Factor group', type: 'IfcGroup' },
  ]);
  assert.equal(query.relationships({ modelId: 'default', expressId: 1 }).relations?.some((edge) =>
    edge.relationshipId === 13 && edge.entity.type === 'IfcDoorStandardCase'), true);

  assert.deepEqual(query.related(building, 'IfcRelAggregates', 'forward'), [{ modelId: 'default', expressId: 3 }]);
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 3 && edge.entity.name === 'First wall'), true);

  writes.setPositionalAttribute({ modelId: 'default', expressId: 3 }, 2, "'Positional parsed wall'");
  view.setAttribute(3, 'Name', 'Named parsed wall');
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 3
    && edge.entity.name === 'Positional parsed wall'), true);
  writes.setPositionalAttribute({ modelId: 'default', expressId: 3 }, 2, null);
  assert.equal(query.entityData({ modelId: 'default', expressId: 3 })?.name, '');
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 3
    && edge.entity.name === undefined), true);

  writes.setPositionalAttribute(relationship, 5, ['#4']);
  assert.deepEqual(query.related(building, 'IfcRelAggregates', 'forward'), [
    { modelId: 'default', expressId: 3 }, { modelId: 'default', expressId: 4 },
  ]);
  const rows = query.relationships(building).relations ?? [];
  assert.equal(rows.some((edge) => edge.relationshipId === relationship.expressId && edge.entity.id === 3), false);
  assert.equal(rows.some((edge) => edge.relationshipId === relationship.expressId
    && edge.entity.id === 4 && edge.entity.name === 'Replacement wall'), true);

  view.setAttribute(relationship.expressId, 'RelatedObjects', '#3');
  // Positional overrides are serialized after named overrides, regardless of
  // authoring order, so pending query results must keep the positional target.
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 3), false);
  assert.equal(query.relationships(building).relations?.some((edge) =>
    edge.relationshipId === relationship.expressId && edge.entity.id === 4), true);

  // Endpoint edits on parsed relationships replace, rather than augment, the immutable graph.
  view.setAttribute(5, 'RelatedObjects', '#4');
  assert.deepEqual(query.related(building, 'IfcRelAggregates', 'forward'), [
    { modelId: 'default', expressId: 4 },
  ]);
  const sourceRows = query.relationships(building).relations?.filter(edge => edge.relationshipId === 5) ?? [];
  assert.deepEqual(sourceRows.map(edge => edge.entity.id), [4]);

  const createdWall = writes.addEntity('default', {
    type: 'IfcWall',
    attributes: ["'0000000000000000000006'", null, "'Overlay wall'", null, null, null, null, null, null],
  });
  const createdRelationship = writes.addEntity('default', {
    type: 'IfcRelAggregates',
    attributes: ["'0000000000000000000007'", null, null, null, '#2', [`#${createdWall.expressId}`]],
  });
  assert.equal(query.relationships(building).relations?.some(edge =>
    edge.relationshipId === createdRelationship.expressId && edge.entity.name === 'Overlay wall'), true);
  writes.setPositionalAttribute(createdWall, 2, "'Positional overlay wall'");
  view.setAttribute(createdWall.expressId, 'Name', 'Later named overlay wall');
  assert.equal(query.relationships(building).relations?.some(edge =>
    edge.relationshipId === createdRelationship.expressId && edge.entity.name === 'Positional overlay wall'), true);

  const host = { modelId: 'default', expressId: 8 };
  assert.deepEqual(query.relationships(host).voids.map(entity => entity.id), [7]);
  const duplicateVoid = writes.addEntity('default', {
    type: 'IfcRelVoidsElement',
    attributes: ["'0000000000000000000012'", null, null, null, '#8', '#7'],
  });
  assert.deepEqual(query.relationships(host).voids.map(entity => entity.id), [7]);
  assert.equal(query.relationships(host).relations?.filter(edge =>
    edge.relationshipType === 'IfcRelVoidsElement' && edge.entity.id === 7).length, 2);
  writes.removeEntity(duplicateVoid);
  writes.removeEntity({ modelId: 'default', expressId: 9 });
  assert.deepEqual(query.relationships(host).voids, []);
  writes.removeEntity(host);
  assert.deepEqual(query.relationships(host), { voids: [], fills: [], groups: [], connections: [], relations: [] });
});
