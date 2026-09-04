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
 * which reads the model's own `schemaVersion` first and the other bundled
 * tables only for leaf spellings that schema does not declare at all.
 *
 * The last case is the one that pins this adapter rather than the resolver.
 * `schemaVersion` is an OPTIONAL parameter of `expandTypes` (it has to be: the
 * function is published, and requiring it would be a major), and omitting it
 * unions the three bundled schemas rather than failing. So a caller that stops
 * passing it does not break the build and does not break the other cases here
 * either, since a union is a superset and they all assert presence. This one
 * asserts an ABSENCE that only the per-schema answer has, which is what makes
 * it red when the argument goes away.
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

// IFC2X3 puts IfcProject under IfcObject; IFC4 moved it to IfcContext. The
// fixture's IFCPROJECT therefore answers `byType('IfcObject')` on this model
// and not on the IFC4 one, which is what makes the last case discriminate.
const IFC2X3_MODEL = ifcFile(`#70= IFCWALL('${guid('WAL1')}',$,'Wall',$,$,$,$,'tag');`, 'IFC2X3');

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

test('queryEntities("IfcBuiltElement") resolves the IFC4X3 rename of IfcBuildingElement', async () => {
  const dataStore = await parse(IFC4X3_MODEL);
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcBuiltElement'] });
  assert.equal(results.length, 2);
});

test('queryEntities("IfcObject") follows the model\'s own schema, not a default (IFC2X3)', async () => {
  // IfcProject is an IfcObject in IFC2X3 and an IfcContext from IFC4 on. Both
  // halves matter: the first says the IFC2X3 model finds its project, and the
  // second says the IFC4 model does NOT. Drop the `store.schemaVersion`
  // argument and the expansion unions the schemas, IFCPROJECT comes back on
  // IFC4 too, and the second half fails.
  const dataStore = await parse(IFC2X3_MODEL);
  assert.equal(dataStore.schemaVersion, 'IFC2X3');
  const adapter = createQueryAdapter(makeStore(dataStore));
  const results = adapter.entities({ modelId: 'default', types: ['IfcObject'] });
  assert.equal(results.length, 2);

  const ifc4 = await parse(IFC4_MODEL);
  const ifc4Adapter = createQueryAdapter(makeStore(ifc4));
  const ifc4Results = ifc4Adapter.entities({ modelId: 'default', types: ['IfcObject'] });
  assert.ok(!ifc4Results.some((e) => e.type.toUpperCase() === 'IFCPROJECT'));
});
