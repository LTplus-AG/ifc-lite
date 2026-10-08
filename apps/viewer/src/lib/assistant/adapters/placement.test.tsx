/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore, type FederatedModel } from '@/store';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { useAssistant, cancelAssistant } from '../conversation';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

async function parseSample(name: string): Promise<IfcDataStore> {
  const bytes = await readFile(new URL(`../../../../public/samples/${name}`, import.meta.url));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

function parsed(id: string, store: IfcDataStore, idOffset: number): FederatedModel {
  return { ...fixtureModel(id, { idOffset }), name: `${id}.ifc`, ifcDataStore: store, maxExpressId: 90_000 } as unknown as FederatedModel;
}

type Row = Record<string, unknown> & { localPlacement: { translation: number[] }; mapConversion: Record<string, unknown> | null;
  projectedCRS: Record<string, unknown> | null };
const rowsOf = (snapshot: { payload: string }): Row[] => JSON.parse(snapshot.payload).evidence.rows.map((row: { data: Row }) => row.data);

/** A georeferenced real model, a real model without a georeference, and one whose data cannot say. */
async function seed() {
  const [architecture, wall] = await Promise.all([parseSample('building-architecture.ifc'), parseSample('hello-wall.ifc')]);
  useViewerStore.setState({ ...fixtureModels(parsed('arch', architecture, 0), parsed('wall', wall, 100_000), fixtureModel('streamed')),
    editEnabled: true, collabRole: null });
}

// #6833: one row per model, the effective georeference with frozen field names, unknown stays unknown.
test('placement evidence states each model\'s georeference as present, absent or unknown from real files', async () => {
  await seed();
  const snapshot = captureEvidence('placement');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 3);
  assert.equal(payload.evidence.summary.modelCount, 3);
  const [arch, wall, streamed] = rowsOf(snapshot);
  assert.equal(arch.modelId, 'arch');
  assert.equal(arch.georeferencePresent, true);
  assert.equal(arch.status, 'georeference-present');
  assert.equal(arch.projectedCRS?.name, 'EPSG:32760');
  assert.equal(arch.projectedCRS?.geodeticDatum, 'WGS 84');
  assert.ok(Math.abs(Number(arch.mapConversion?.eastings) - 729013348.8297004) < 1e-3, 'file eastings, in the map unit');
  assert.ok(Math.abs(Number(arch.mapConversion?.xAxisOrdinate) - 0.8660254037844387) < 1e-12);
  assert.equal(arch.doubleGeoreference, null, 'no geometry bounds were loaded, so it is not evaluated');
  assert.equal(wall.georeferencePresent, false);
  assert.equal(wall.mapConversion, null);
  assert.equal(streamed.georeferencePresent, null, 'a store without STEP source cannot say');
  assert.equal(streamed.status, 'georeference-unknown');
  assert.deepEqual(arch.localPlacement.translation, [0, 0, 0]);
  assert.equal(evidenceIsCurrent(snapshot), true);
});

test('a committed move and a georeference edit each make placement evidence stale and show in a fresh capture', async () => {
  await seed();
  const before = captureEvidence('placement');
  const state = useViewerStore.getState();
  state.openReposition(['wall']);
  useViewerStore.getState().previewModelTranslation([5, 0, 0]);
  useViewerStore.getState().applyModelTranslation();
  assert.equal(evidenceIsCurrent(before), false, 'modelPlacement was replaced');
  const moved = captureEvidence('placement');
  assert.deepEqual(rowsOf(moved)[1].localPlacement.translation, [5, 0, 0]);
  assert.equal(JSON.parse(moved.payload).evidence.summary.movedModels, 1);

  useViewerStore.getState().setGeorefField('arch', 'mapConversion', 'eastings', 1234, 729013348.8297004);
  assert.equal(evidenceIsCurrent(moved), false, 'a georeference edit is an edit');
  const edited = rowsOf(captureEvidence('placement'))[0];
  assert.equal(edited.mapConversion?.eastings, 1234);
  assert.equal(edited.georeferenceEdited, true);
});

test('placement is unavailable with no model loaded', () => {
  useViewerStore.setState(fixtureModels());
  const snapshot = captureEvidence('placement');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('the Placement panel header discusses the placement source', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const ui = render(renderPanelBody('placement', () => undefined));
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'placement');
});
