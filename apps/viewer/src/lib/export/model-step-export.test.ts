/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { parseFixtureModel, FIXTURE_WALL_A, FIXTURE_WALL_B } from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { exportModelStep } from './model-step-export';

async function parse(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

test('shared download/cloud STEP source round-trips edits without contaminating another model (#6587)', async () => {
  const dataStore = await parseFixtureModel();
  const mutationView = new MutablePropertyView(dataStore.properties ?? null, 'edited');
  configureMutationView(mutationView, dataStore);
  mutationView.setExpressIdWatermark(Math.max(...dataStore.entityIndex.byId.keys()));
  mutationView.setAttribute(FIXTURE_WALL_A, 'Name', 'Changed for upload', 'Wall A');
  mutationView.deleteEntity(FIXTURE_WALL_B);
  const created = mutationView.createEntity('IfcWall', ['2Wall00000000000000012', null, 'Created for upload']).expressId;
  const result = await exportModelStep({
    modelId: 'edited', dataStore, mutationView,
    options: { schema: 'IFC4', includeGeometry: true, applyMutations: true }, scheduleState: null,
  });
  const edited = await parse(result.content);
  assert.equal(edited.entities.getName(FIXTURE_WALL_A), 'Changed for upload');
  assert.equal(edited.entityIndex.byId.has(FIXTURE_WALL_B), false);
  assert.equal(edited.entities.getName(created), 'Created for upload');
  const untouched = await exportModelStep({
    modelId: 'other', dataStore, options: { schema: 'IFC4', applyMutations: true }, scheduleState: null,
  });
  const original = await parse(untouched.content);
  assert.equal(original.entities.getName(FIXTURE_WALL_A), 'Wall A');
  assert.equal(original.entityIndex.byId.has(FIXTURE_WALL_B), true);
});

test('shared STEP source respects per-model visibility filters (#6587)', async () => {
  const result = await exportModelStep({
    modelId: 'visible', dataStore: await parseFixtureModel(),
    options: { schema: 'IFC4', applyMutations: true, visibleOnly: true, hiddenEntityIds: new Set([FIXTURE_WALL_B]) },
    scheduleState: null,
  });
  const visible = await parse(result.content);
  assert.equal(visible.entityIndex.byId.has(FIXTURE_WALL_B), false);
  assert.equal(visible.entities.getName(FIXTURE_WALL_A), 'Wall A');
});

test('cloud STEP source carries edited map conversion and source schema (#6587)', async () => {
  const fixture = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCUNITASSIGNMENT(());
ENDSEC;
END-ISO-10303-21;`;
  const result = await exportModelStep({
    modelId: 'geo', dataStore: await parse(fixture),
    options: {
      schema: 'IFC4X3', applyMutations: true,
      georefMutations: {
        projectedCRS: { name: 'EPSG:2056', mapUnit: 'METRE' },
        mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1 },
      },
    },
    scheduleState: null,
  });
  const exported = await parse(result.content);
  const { extractGeoreferencingOnDemand } = await import('@ifc-lite/parser');
  const geo = extractGeoreferencingOnDemand(exported);
  assert.equal(exported.schemaVersion, 'IFC4X3');
  assert.equal(geo?.projectedCRS?.name, 'EPSG:2056');
  assert.equal(geo?.mapConversion?.eastings, 2600000);
  assert.equal(geo?.mapConversion?.northings, 1200000);
  assert.equal(geo?.mapConversion?.orthogonalHeight, 500);
  assert.equal(geo?.mapConversion?.xAxisAbscissa, 0);
  assert.equal(geo?.mapConversion?.xAxisOrdinate, 1);
  assert.deepEqual(result.stats.warnings, []);
});

test('real SketchUp IFC4 map-unit conversion survives cloud serialization (#6587)', async context => {
  const { readFile } = await import('node:fs/promises');
  const path = new URL('../../../../../tests/models/buildingsmart/Infra-Bridge.ifc', import.meta.url);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip('Infra-Bridge fixture missing; run pnpm fixtures');
      return;
    }
    throw error;
  }
  const dataStore = await parse(bytes);
  const result = await exportModelStep({
    modelId: 'sketchup-bridge', dataStore,
    options: { schema: 'IFC4', applyMutations: true, includeGeometry: true }, scheduleState: null,
  });
  const { extractGeoreferencingOnDemand } = await import('@ifc-lite/parser');
  const geo = extractGeoreferencingOnDemand(await parse(result.content));
  assert.equal(geo?.projectedCRS?.name, 'EPSG:32760');
  assert.equal(geo?.projectedCRS?.mapUnitScale, 0.001);
  assert.equal(geo?.mapConversion?.eastings, 729011225.8823584);
  assert.equal(geo?.mapConversion?.northings, 9063960607.644705);
  assert.equal(geo?.mapConversion?.orthogonalHeight, 0);
  assert.deepEqual(result.stats.warnings, []);
});
