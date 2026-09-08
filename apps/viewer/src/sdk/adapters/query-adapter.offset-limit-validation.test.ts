/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `queryEntities()`'s `offset`/`limit` validation must match the CLI
 * (`packages/cli/src/headless-backend.ts`) and MCP (`packages/mcp/src/backend-query.ts`)
 * backends: a non-finite or negative value is a caller bug and should throw,
 * not be silently coerced to "no offset/limit applied" (which used to serve
 * MORE rows than a caller who passed a bad computed value asked for, and made
 * a deliberate `limit: 0` behave like "no limit" instead of "zero rows").
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
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#73),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
ENDSEC;
END-ISO-10303-21;
`;

function makeStore(dataStore: IfcDataStore): StoreApi {
  return {
    getState: () => ({ ifcDataStore: dataStore, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('queryEntities throws on a negative/non-finite offset or limit instead of silently ignoring it', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);
  const adapter = createQueryAdapter(makeStore(dataStore));

  assert.throws(() => adapter.entities({ modelId: 'default', types: ['IfcWall'], offset: NaN }), TypeError);
  assert.throws(() => adapter.entities({ modelId: 'default', types: ['IfcWall'], offset: -1 }), TypeError);
  assert.throws(() => adapter.entities({ modelId: 'default', types: ['IfcWall'], limit: NaN }), TypeError);
  assert.throws(() => adapter.entities({ modelId: 'default', types: ['IfcWall'], limit: -1 }), TypeError);
});

test('queryEntities treats limit: 0 as zero rows, not "no limit"', async () => {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(MODEL).buffer as ArrayBuffer;
  const dataStore = await parser.parseColumnar(buffer);
  const adapter = createQueryAdapter(makeStore(dataStore));

  const results = adapter.entities({ modelId: 'default', types: ['IfcWall'], limit: 0 });
  assert.deepEqual(results, []);
});
