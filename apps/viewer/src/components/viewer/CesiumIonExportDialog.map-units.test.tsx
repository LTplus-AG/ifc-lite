/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityExtractor, IfcParser, extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { render, click, type, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import type { IonUploadInput } from '@/lib/geo/cesium-ion-upload';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';
import { initializeIonExportWasm } from './CesiumIonExportDialog.wasm.test-support';

before(initializeIonExportWasm);

afterEach(cleanup);
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
  assert.ok(found, `Missing button: ${text}`);
  return found;
};
async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}
function attributes(store: IfcDataStore) {
  // One reusable typed decoder of indexed entities, not repeated whole-file
  // on-demand attribute extraction or assertions on STEP source text.
  const extractor = new EntityExtractor(store.source);
  return (id: number) => {
    const record = store.entityIndex.byId.get(id);
    assert.ok(record, `Missing entity #${id}`);
    const entity = extractor.extractEntity(record);
    assert.ok(entity, `Unreadable entity #${id}`);
    return entity.attributes ?? [];
  };
}
function physicalMapPoint(attrs: unknown[], metresPerMapUnit: number, point: number[]) {
  const x = Number(attrs[5] ?? 1), y = Number(attrs[6] ?? 0), norm = Math.hypot(x, y);
  const scale = Number(attrs[7] ?? 1);
  return [
    metresPerMapUnit * (Number(attrs[2]) + scale * (x * point[0] - y * point[1]) / norm),
    metresPerMapUnit * (Number(attrs[3]) + scale * (y * point[0] + x * point[1]) / norm),
    metresPerMapUnit * (Number(attrs[4]) + scale * point[2]),
  ];
}

test('mounted ion caller normalizes real SketchUp map units after selected-model Name edits without scaling geometry (#6587)', async context => {
  let source: Uint8Array;
  try {
    source = new Uint8Array(await readFile(new URL('../../../../../tests/models/buildingsmart/Infra-Bridge.ifc', import.meta.url)));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip('Infra-Bridge fixture missing; run pnpm fixtures'); return;
    }
    throw error;
  }
  const dataStore = await parse(source);
  const target = { ...fixtureModel('Infra-Bridge.ifc', { idOffset: 1_000_000 }), ifcDataStore: dataStore, schemaVersion: 'IFC4' as const };
  const other = { ...fixtureModel('Other-Bridge.ifc', { idOffset: 2_000_000 }), ifcDataStore: dataStore, schemaVersion: 'IFC4' as const };
  const targetView = new MutablePropertyView(dataStore.properties ?? null, target.id);
  const otherView = new MutablePropertyView(dataStore.properties ?? null, other.id);
  configureMutationView(targetView, dataStore); configureMutationView(otherView, dataStore);
  const editedName = 'Ion normalization acceptance edited girder';
  assert.equal(dataStore.entities.getGlobalId(288), '1dmYPmycr2LPQju29cHK45');
  targetView.setAttribute(288, 'Name', editedName, dataStore.entities.getName(288) ?? undefined);
  otherView.setAttribute(288, 'Name', 'Unselected model edit', dataStore.entities.getName(288) ?? undefined);
  useViewerStore.setState({ ...fixtureModels(other, target), activeModelId: other.id,
    mutationViews: new Map([[target.id, targetView], [other.id, otherView]]), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let sent: IonUploadInput | undefined;
  // Only the network boundary is replaced: this mounted caller must invoke
  // the actual shared exporter, its overlay resolution and normalization.
  render(<CesiumIonExportDialog surface="ribbon" upload={async input => { sent = input; return { assetId: 42 }; }} />);
  click(button('Upload to Cesium ion'));
  const select = document.querySelector<HTMLButtonElement>('#ion-model');
  assert.ok(select); assert.match(select.textContent ?? '', /Other-Bridge/);
  click(select);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === 'Infra-Bridge.ifc');
  assert.ok(option, 'real model selector offers the target'); click(option);
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => sent !== undefined, 'real serializer did not reach the upload transport');
  assert.ok(sent); assert.equal(sent.fileName, 'Infra-Bridge.ifc');
  const output = await parse(sent.bytes);
  assert.equal(output.entities.getName(288), editedName, 'normalization must consume edited export, not original source');
  assert.equal(output.entities.getGlobalId(288), dataStore.entities.getGlobalId(288));
  const before = attributes(dataStore), after = attributes(output);
  const conversionId = dataStore.entityIndex.byType.get('IFCMAPCONVERSION')?.[0];
  assert.ok(conversionId);
  const originalMap = before(conversionId), normalizedMap = after(conversionId);
  const crsId = Number(normalizedMap[1]);
  const metreId = Number(after(crsId)[6]);
  assert.deepEqual(after(metreId).slice(1), ['.LENGTHUNIT.', null, '.METRE.']);
  assert.equal(extractGeoreferencingOnDemand(output)?.projectedCRS?.mapUnitScale, 1);
  assert.equal(normalizedMap[7], 0.001, 'effective Scale is converted exactly once with millimetre MapUnit');
  // Check all XYZ at nonzero independent engineering coordinates. Offsets
  // alone miss lost/doubled scale, including the vertical dimension.
  for (const point of [[0, 0, 0], [18000, -2700, 4900], [-991, 213, 778]]) {
    const expected = physicalMapPoint(originalMap, 0.001, point);
    const actual = physicalMapPoint(normalizedMap, 1, point);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(actual[axis] - expected[axis]) <= Math.max(1e-8, 4 * Number.EPSILON * Math.abs(expected[axis])),
        `physical map coordinate ${axis} changed at ${point}`);
    }
  }
  const projectId = dataStore.entityIndex.byType.get('IFCPROJECT')?.[0];
  assert.ok(projectId);
  assert.deepEqual(after(projectId), before(projectId));
  const unitAssignmentId = Number(before(projectId)[8]);
  assert.deepEqual(after(unitAssignmentId), before(unitAssignmentId));
  // A cloud-specific unit conversion must not scale or discard engineering
  // geometry, placements or representations in this authored model.
  const geometryTypes = new Set(['IFCCARTESIANPOINT', 'IFCDIRECTION', 'IFCLOCALPLACEMENT',
    'IFCAXIS2PLACEMENT3D', 'IFCEXTRUDEDAREASOLID', 'IFCRECTANGLEPROFILEDEF',
    'IFCPRODUCTDEFINITIONSHAPE', 'IFCSHAPEREPRESENTATION']);
  let checkedGeometry = 0;
  for (const [id, record] of dataStore.entityIndex.byId) {
    if (geometryTypes.has(record.type)) {
      assert.deepEqual(after(id), before(id), `engineering geometry #${id} changed`); checkedGeometry++;
    }
  }
  assert.ok(checkedGeometry > 100, 'the real model geometry invariant must be nonempty');
  assert.equal(dataStore.entities.getName(288), 'road river bridge - main girder', 'source store stays original');
  assert.deepEqual(targetView.getAttributeMutationsForEntity(288), [{ name: 'Name', value: editedName }]);
  assert.deepEqual(otherView.getAttributeMutationsForEntity(288), [{ name: 'Name', value: 'Unselected model edit' }]);
});
