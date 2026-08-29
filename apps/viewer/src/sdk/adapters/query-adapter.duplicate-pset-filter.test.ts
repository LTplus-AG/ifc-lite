/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct IfcPropertySets that
 * share the same name (e.g. one from the type definition, one from the
 * occurrence). `queryEntities()`'s property filter in query-adapter.ts
 * used to do `props.find(p => p.name === filter.psetName)`, which only
 * ever sees the FIRST same-named set -- an entity whose wanted property
 * lives on the SECOND same-named set was silently excluded from the
 * result set, with no indication anything was omitted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall #72 carries TWO "Pset_WallCommon" sets: the first (#80) has only
// IsExternal, the second (#83) has the FireRating we're filtering on.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
ENDSEC;
END-ISO-10303-21;
`;

function makeStore(store: unknown): StoreApi {
  return {
    getState: () => ({ ifcDataStore: store, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('queryEntities property filter does not silently exclude an entity whose filtered property lives on the SECOND same-named set', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);

  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({
    modelId: 'default',
    types: ['IfcWall'],
    filters: [{ psetName: 'Pset_WallCommon', propName: 'FireRating', operator: '=', value: 'REI60' }],
  });

  assert.deepEqual(results.map((e) => e.name), ['Wall A']);
});

test('queryEntities property filter still matches on the FIRST same-named set', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);

  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({
    modelId: 'default',
    types: ['IfcWall'],
    filters: [{ psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: '=', value: true }],
  });

  assert.deepEqual(results.map((e) => e.name), ['Wall A']);
});
