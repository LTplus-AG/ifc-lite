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
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall #72 carries TWO "Pset_WallCommon" sets: the first (#80) has only
// IsExternal, the second (#83) has the FireRating we're filtering on.
//
// Wall #90 (Wall F) carries TWO "Pset_WallCommon" sets that BOTH carry
// FireRating, with DIFFERENT values: #92 (first) is 'REI30' (does not
// match), #95 (second) is 'REI60' (matches). This is the shape #3490
// actually reports — `findPropertyInSets` finds the property on the
// FIRST set either way, so testing only that one value wrongly excludes
// the wall when the match lives on the second set.
//
// Wall #100 (Wall G) carries the same two-set shape with NEITHER value
// matching — the negative control.
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
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#90,#100),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
#90= IFCWALL('${guid('WALF')}',$,'Wall F',$,$,#40,$,'tagF',$);
#91= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);
#92= IFCPROPERTYSET('${guid('PST3')}',$,'Pset_WallCommon',$,(#91));
#93= IFCRELDEFINESBYPROPERTIES('${guid('RDP3')}',$,$,$,(#90),#92);
#94= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#95= IFCPROPERTYSET('${guid('PST4')}',$,'Pset_WallCommon',$,(#94));
#96= IFCRELDEFINESBYPROPERTIES('${guid('RDP4')}',$,$,$,(#90),#95);
#100= IFCWALL('${guid('WALG')}',$,'Wall G',$,$,#40,$,'tagG',$);
#101= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);
#102= IFCPROPERTYSET('${guid('PST5')}',$,'Pset_WallCommon',$,(#101));
#103= IFCRELDEFINESBYPROPERTIES('${guid('RDP5')}',$,$,$,(#100),#102);
#104= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI45'),$);
#105= IFCPROPERTYSET('${guid('PST6')}',$,'Pset_WallCommon',$,(#104));
#106= IFCRELDEFINESBYPROPERTIES('${guid('RDP6')}',$,$,$,(#100),#105);
ENDSEC;
END-ISO-10303-21;
`;

/**
 * The adapter reads only `ifcDataStore` and `models` off the store, and the
 * data store here is a REAL one (`parseColumnar` over the STEP above), not a
 * stub -- so the property sets under test come from the actual extraction
 * path. Only the surrounding `ViewerState` is shimmed, the same way
 * `query-adapter.active-filter.test.ts` next door does it.
 */
function makeStore(dataStore: IfcDataStore): StoreApi {
  return {
    getState: () => ({ ifcDataStore: dataStore, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('queryEntities property filter does not silently exclude an entity whose filtered property lives on the SECOND same-named set (Wall A: FIRST set has no FireRating at all), and any-matches an entity whose SECOND set overrides a non-matching value on the FIRST (Wall F: #3490)', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);

  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({
    modelId: 'default',
    types: ['IfcWall'],
    filters: [{ psetName: 'Pset_WallCommon', propName: 'FireRating', operator: '=', value: 'REI60' }],
  });

  assert.deepEqual(results.map((e) => e.name), ['Wall A', 'Wall F']);
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

test('queryEntities property filter excludes an entity where NEITHER same-named set matches', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);

  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({
    modelId: 'default',
    types: ['IfcWall'],
    filters: [{ psetName: 'Pset_WallCommon', propName: 'FireRating', operator: '=', value: 'REI99' }],
  });

  assert.deepEqual(results.map((e) => e.name), []);
});
