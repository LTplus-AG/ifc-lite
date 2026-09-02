/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `queryEntities()`'s `descriptor.types` expansion used to walk a fixed
 * nine-entry `IFC_SUBTYPES` table (only `*StandardCase`/`*ElementedCase`
 * aliases), imported from `@ifc-lite/parser`. Asking for an abstract EXPRESS
 * supertype (`IfcBuildingElement`, `IfcElement`) is never a literal STEP
 * entity type, so that table had no row for it and querying by it silently
 * answered zero entities on a model full of matching elements. `expandTypes`
 * now delegates to `@ifc-lite/data`'s schema-driven descendant resolver,
 * keyed off the model's own `schemaVersion`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

function ifcFile(dataSection: string, schema: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
${dataSection}
ENDSEC;
END-ISO-10303-21;
`;
}

const IFC4_MODEL = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall 1',$,$,$,$,'tag',$);
#71= IFCWALLSTANDARDCASE('${guid('WAL2')}',$,'Wall 2',$,$,$,$,'tag',$);
#72= IFCSLAB('${guid('SLAB')}',$,'Slab',$,$,$,$,'tag',$);
#73= IFCCOLUMN('${guid('COLM')}',$,'Column',$,$,$,$,'tag',$);`, 'IFC4');

const IFC4X3_MODEL = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall',$,$,$,$,'tag',$);
#71= IFCCOURSE('${guid('CRSE')}',$,'Course',$,$,$,$,'tag',$);`, 'IFC4X3');

function makeStore(dataStore: IfcDataStore): StoreApi {
  return {
    getState: () => ({ ifcDataStore: dataStore, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

async function parse(source: string): Promise<IfcDataStore> {
  const parser = new IfcParser();
  const buffer = new TextEncoder().encode(source).buffer as ArrayBuffer;
  return parser.parseColumnar(buffer);
}

test('queryEntities("IfcBuildingElement") finds all 4 concrete building elements, not 0 (IFC4)', async () => {
  const dataStore = await parse(IFC4_MODEL);
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcBuildingElement'] });
  assert.equal(results.length, 4);
});

test('queryEntities("IfcWall") still returns 2 — no regression on the StandardCase alias', async () => {
  const dataStore = await parse(IFC4_MODEL);
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcWall'] });
  assert.equal(results.length, 2);
});

test('queryEntities("IfcFooting") — a real IFC type with no instances in this fixture — returns 0', async () => {
  const dataStore = await parse(IFC4_MODEL);
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcFooting'] });
  assert.equal(results.length, 0);
});

test('queryEntities("IfcBuiltElement") resolves per the model\'s own IFC4X3 schema', async () => {
  const dataStore = await parse(IFC4X3_MODEL);
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcBuiltElement'] });
  assert.equal(results.length, 2);
});
