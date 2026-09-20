/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';
import { isProductType } from './query-entity-filter.js';

const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Wall',$,'Kind',$,$,$,$);ENDSEC;END-ISO-10303-21;`;

async function harness() {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm',
    ifcDataStore: dataStore,
    mutationViews: new Map([['m', view]]),
    getMutationView: (id: string) => (id === 'm' ? view : null),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { adapter: createQueryAdapter(store), view };
}

test('parsed entity reads name positional slots by the effective class and honour a GlobalId edit (#5009 review)', async () => {
  const { adapter, view } = await harness();
  const ref = { modelId: 'm', expressId: 3 };
  // IfcWall → IfcRelAggregates has a different layout: slot 4 is RelatingObject,
  // not ObjectType, so a positional write there must NOT surface as objectType.
  view.setEntityType(3, 'IfcRelAggregates');
  view.setPositionalAttribute(3, 4, '#1');
  view.setPositionalAttribute(3, 0, "'0000000000000000000099'");
  const data = adapter.entityData(ref);
  assert.equal(data?.type, 'IfcRelAggregates');
  assert.equal(data?.objectType, '', 'slot 4 of the effective class is RelatingObject, not ObjectType');
  assert.equal(data?.globalId, '0000000000000000000099', 'a positional GlobalId edit is a GlobalId edit');
});

test('a no-type scan keeps object classes outside the render enum (#5009 review)', () => {
  for (const type of ['IfcTendonAnchor', 'IfcFastener', 'IfcCableCarrierSegment', 'IfcWall']) {
    assert.equal(isProductType(type), true, type);
  }
  for (const type of ['IfcWallType', 'IfcRelAggregates', 'IfcPropertySet', 'IfcCartesianPoint']) {
    assert.equal(isProductType(type), false, type);
  }
});
