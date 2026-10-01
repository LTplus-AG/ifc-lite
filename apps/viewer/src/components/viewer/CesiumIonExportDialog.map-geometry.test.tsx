/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { before, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityExtractor, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
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

async function sourceModel(): Promise<IfcDataStore | undefined> {
  try {
    const bytes = await readFile(new URL('../../../../../tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc', import.meta.url));
    return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function attrs(store: IfcDataStore, id: number) {
  const record = store.entityIndex.byId.get(id);
  assert.ok(record, `Missing emitted entity #${id}`);
  const entity = new EntityExtractor(store.source).extractEntity(record);
  assert.ok(entity, `Unreadable emitted entity #${id}`);
  return entity.attributes;
}

function begin(store: IfcDataStore, view: MutablePropertyView, upload: typeof import('@/lib/geo/cesium-ion-upload').uploadToCesiumIon) {
  const model = { ...fixtureModel('Golden-Gate-deck.ifc'), ifcDataStore: store, schemaVersion: 'IFC4X3' as const };
  configureMutationView(view, store);
  useViewerStore.setState({ ...fixtureModels(model), activeModelId: model.id, mutationViews: new Map([[model.id, view]]),
    georefMutations: new Map(), scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  render(<CesiumIonExportDialog surface="ribbon" upload={upload} />);
  const button = (name: string) => {
    const result = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
    assert.ok(result, `Missing ${name} button`); return result;
  };
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
}

test('mounted ion upload applies edited public IFC4X3 map rotation/scale through real WASM (#6587)', async context => {
  const source = await sourceModel();
  if (!source) { context.skip('Public bridge-deck fixture missing; run pnpm fixtures'); return; }
  const view = new MutablePropertyView(source.properties ?? null, 'deck');
  const originalName = source.entities.getName(16);
  const editedName = 'Ion compatibility edited bridge deck';
  view.setAttribute(16, 'Name', editedName, source.entities.getName(16) ?? undefined);
  let sent: IonUploadInput | undefined;
  // Only transport is replaced: caller selection, edits and both compatibility
  // passes execute against the real fixture and actual canonical WASM backend.
  begin(source, view, async input => { sent = input; return { assetId: 42 }; });
  await waitFor(() => sent !== undefined, 'real edited compatibility export did not reach transport');
  assert.ok(sent);
  const output = await new IfcParser().parseColumnar(sent.bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(output.schemaVersion, 'IFC4X3');
  assert.deepEqual(output.sourceHeader?.schemaIdentifiers, source.sourceHeader?.schemaIdentifiers);
  assert.equal(output.entities.getName(16), editedName);
  assert.equal(output.entities.getGlobalId(16), '1BvdN7mUjD7A_lI6KfHKqB');
  assert.deepEqual(attrs(output, 38).slice(2, 8), [0, 0, 0, 1, 0, 1], 'map affine is carried by placements and mapped shapes');
  const placement = attrs(output, Number(attrs(output, 16)[5]));
  assert.equal(placement[0], null, 'logical placement is independently rooted');
  const frame = attrs(output, Number(placement[1]));
  const point = attrs(output, Number(frame[0]))[0];
  assert.ok(Array.isArray(point));
  // Independent authored origin (0,0,67) under its documented map similarity.
  const expected = [545991.679663973, 4184941.96970872, 67 * 0.9996];
  point.forEach((value, axis) => assert.ok(Math.abs(Number(value) - expected[axis]) < 1e-8));
  const definition = attrs(output, Number(attrs(output, 16)[6]));
  assert.ok(Array.isArray(definition[2]));
  const representation = attrs(output, Number(definition[2][0]));
  assert.equal(representation[2], 'MappedRepresentation');
  assert.ok(Array.isArray(representation[3]));
  const mapped = attrs(output, Number(representation[3][0]));
  const operator = attrs(output, Number(mapped[1]));
  assert.equal(operator[3], 0.9996, 'uniform representation scale is applied exactly once');
  for (const id of [1, 2, 5, 22, 24, 28, 29]) assert.deepEqual(attrs(output, id), attrs(source, id), `authored units/body #${id} preserved`);
  assert.equal(source.entities.getName(16), originalName);
  assert.deepEqual(view.getAttributeMutationsForEntity(16), [{ name: 'Name', value: editedName }]);
});

test('mounted ion upload refuses unsupported edited map scale before network transfer (#6587)', async context => {
  const source = await sourceModel();
  if (!source) { context.skip('Public bridge-deck fixture missing; run pnpm fixtures'); return; }
  const view = new MutablePropertyView(source.properties ?? null, 'deck-invalid');
  view.setAttribute(38, 'Scale', '-1', '0.9996');
  let transfers = 0;
  begin(source, view, async () => { transfers++; return { assetId: 42 }; });
  await waitFor(() => document.body.textContent?.includes('IFC preparation reported') === true,
    'canonical normalization warning was not reported by the mounted dialog');
  assert.equal(transfers, 0, 'a refused map normalization must never reach upload transport');
  assert.equal(attrs(source, 38)[7], 0.9996, 'source remains authored');
  assert.deepEqual(view.getAttributeMutationsForEntity(38), [{ name: 'Scale', value: '-1' }]);
});
