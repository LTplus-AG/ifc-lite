/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `queryEntities()`'s `where(..., 'contains', ...)` filter must behave the
 * same everywhere the public SDK `QueryDescriptor` contract is implemented.
 * `packages/cli/src/headless-backend.ts` and `packages/mcp/src/backend-query.ts`
 * both lowercase both sides before `.includes()` (a deliberate, independently
 * landed fix on each — see the `normalizeBoolean`/`normalizeBooleanValue`
 * comments in those files). This adapter — the one that backs the
 * browser-embedded `bim.query()` SDK surface (viewer sandbox/playground
 * scripts) — never got that fix and compared case-sensitively, so the same
 * `.where('Pset_WallCommon', 'FireRating', 'contains', 'rei')` call silently
 * returns a different result set depending on which host runs the script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

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
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#83);
ENDSEC;
END-ISO-10303-21;
`;

function makeStore(dataStore: IfcDataStore): StoreApi {
  return {
    getState: () => ({ ifcDataStore: dataStore, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('queryEntities "contains" filter matches case-insensitively, like the CLI and MCP backends', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);

  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({
    modelId: 'default',
    types: ['IfcWall'],
    filters: [{ psetName: 'Pset_WallCommon', propName: 'FireRating', operator: 'contains', value: 'rei' }],
  });

  assert.deepEqual(results.map((e) => e.name), ['Wall A']);
});
